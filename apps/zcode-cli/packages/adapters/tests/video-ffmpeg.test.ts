import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRootTraceContext } from "@zcode/contracts";
import type {
  BackgroundExecutionSnapshot,
  ExecutionPort,
  ExecutionRequest,
} from "@zcode/contracts";
import {
  createFfmpegRtspSegmenter,
  createFfmpegVideoFrameAdapter,
  probeFfmpegAvailable,
  SEGMENT_MARKER_FILE_NAME,
} from "../src/video/index.js";
import { createNodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 真 ffmpeg 探测；缺席时跳过（先例 pdf.test.ts）。 */
async function requireFfmpegOrSkip(): Promise<string> {
  const executionPort = createNodeExecutionAdapter();
  try {
    await probeFfmpegAvailable(executionPort, "ffmpeg", undefined);
  } catch {
    return "skip";
  }
  return "ok";
}

describe("ffmpeg-frames", () => {
  it("真 ffmpeg：对生成的测试视频按时间点抽帧", async () => {
    if ((await requireFfmpegOrSkip()) === "skip") return;
    const dir = await makeTempDir("zcode-ffmpeg-frames-");
    const videoPath = join(dir, "input.mp4");
    const gen = createNodeExecutionAdapter();
    const generated = await gen.run({
      command: {
        mode: "argv",
        file: "ffmpeg",
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc=duration=2:size=64x48:rate=10",
          "-y",
          videoPath,
        ],
      },
    });
    assert.equal(generated.exitCode, 0, "test video generation failed");

    const adapter = createFfmpegVideoFrameAdapter({ executionPort: gen });
    const { frames } = await adapter.extractFrames({
      videoRef: videoPath,
      mime: "video/mp4",
      timesMs: [0, 500, 9_999],
      trace: createRootTraceContext(),
    });
    // 9999ms 超出时长 → 无产出帧被跳过，不报错。
    assert.equal(frames.length, 2);
    assert.ok(frames[0].imageDataUrl.startsWith("data:image/jpeg;base64,"));
    assert.ok(frames[0].width > 0 && frames[0].height > 0);
    assert.equal(frames[0].timeMs, 0);
  });

  it("视频文件缺失时抛 typed error", async () => {
    if ((await requireFfmpegOrSkip()) === "skip") return;
    const dir = await makeTempDir("zcode-ffmpeg-frames-missing-");
    const adapter = createFfmpegVideoFrameAdapter({
      executionPort: createNodeExecutionAdapter(),
    });
    await expect(
      adapter.extractFrames({
        videoRef: join(dir, "no-such-file.mp4"),
        mime: "video/mp4",
        timesMs: [0],
        trace: createRootTraceContext(),
      }),
    ).rejects.toMatchObject({ code: "video_frame_extract_failed" });
  });
});

interface FakeBackgroundTask {
  args: string[];
  running: boolean;
}

/** Fake ExecutionPort：run 固定返回成功（供 probe），start/getBackgroundTask/cancel 模拟后台任务。 */
function fakeExecutionPort(): { port: ExecutionPort; tasks: FakeBackgroundTask[] } {
  const tasks: FakeBackgroundTask[] = [];
  const port: ExecutionPort = {
    run: async () => ({
      status: "completed",
      exitCode: 0,
      stdout: { text: "ffmpeg version 7.0", bytes: 18, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      durationMs: 1,
      timedOut: false,
      cancelled: false,
      startedAt: new Date(),
      completedAt: new Date(),
    }),
    async start(request: ExecutionRequest) {
      const command = request.command as { file: string; args: string[] };
      const task: FakeBackgroundTask = { args: command.args, running: true };
      tasks.push(task);
      return {
        taskId: `task-${tasks.length}`,
        status: "running",
        startedAt: new Date(),
      };
    },
    async getBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
      const task = tasks[Number(taskId.replace("task-", "")) - 1];
      if (task === undefined) return undefined;
      return {
        taskId,
        status: task.running ? "running" : "exited",
        startedAt: new Date(),
      };
    },
    async cancelBackgroundTask(taskId: string) {
      const task = tasks[Number(taskId.replace("task-", "")) - 1];
      if (task !== undefined) task.running = false;
      return undefined;
    },
  };
  return { port, tasks };
}

/** 轮询至条件满足（后台 segmenter 是长驻异步流程，用条件等待 + abort 收尾）。 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ffmpeg-rtsp segmenter", () => {
  it("start 的 ffmpeg argv 包含 URL（仅 argv 通道），stop 调用 cancelBackgroundTask", async () => {
    const dir = await makeTempDir("zcode-rtsp-argv-");
    const { port, tasks } = fakeExecutionPort();
    const segmenter = createFfmpegRtspSegmenter({ executionPort: port, pollIntervalMs: 10 });
    // fixture URL 用脱敏形态；argv 断言只看结构不看真实凭据。
    await segmenter.start(
      {
        sourceUrl: "rtsp://user:***@cam.local:554/live",
        outDir: dir,
        segmentSeconds: 30,
        transport: "tcp",
        trace: createRootTraceContext(),
      },
      { signal: undefined },
    );
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].args.includes("-f"));
    assert.ok(tasks[0].args.includes("segment"));
    await segmenter.stop();
    assert.equal(tasks[0].running, false);
  });

  it("关段判定：seq+1 文件出现才算关闭；进程结束后尾部全部关闭", async () => {
    const dir = await makeTempDir("zcode-rtsp-closed-");
    const { port, tasks } = fakeExecutionPort();
    const segmenter = createFfmpegRtspSegmenter({ executionPort: port, pollIntervalMs: 5 });
    await segmenter.start(
      {
        sourceUrl: "rtsp://user:***@cam.local:554/live",
        outDir: dir,
        segmentSeconds: 5,
        transport: "tcp",
        trace: createRootTraceContext(),
      },
      { signal: undefined },
    );
    // 模拟 ffmpeg 输出：seg00000 正在写（无 seg00001）→ 不产出（观察窗口内不关闭）。
    await writeFile(join(dir, "seg00000.mp4"), Buffer.from([0]));
    const controller = new AbortController();
    const yielded: number[] = [];
    const consume = (async () => {
      for await (const segment of segmenter.watchClosedSegments(controller.signal)) {
        yielded.push(segment.seq);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(yielded, [], "live segment must not be closed while seg00001 is absent");
    // 写出 seg00001 → seg00000 关闭。
    await writeFile(join(dir, "seg00001.mp4"), Buffer.from([0]));
    await waitFor(() => yielded.includes(0));
    // 结束进程 → 尾部 seg00001 也视为关闭。
    tasks[0].running = false;
    await waitFor(() => yielded.includes(1));
    await segmenter.stop();
    controller.abort();
    await consume;
  });

  it("非 rtsp scheme（http-flv）不追加 -rtsp_transport（RTSP demuxer 私有选项）", async () => {
    const dir = await makeTempDir("zcode-rtsp-httpflv-");
    const { port, tasks } = fakeExecutionPort();
    const segmenter = createFfmpegRtspSegmenter({ executionPort: port, pollIntervalMs: 10 });
    await segmenter.start(
      {
        sourceUrl: "http://cam.local:48021/live/0.stream.flv",
        outDir: dir,
        segmentSeconds: 3,
        transport: "tcp",
        trace: createRootTraceContext(),
      },
      { signal: undefined },
    );
    assert.ok(tasks.length === 1);
    const index = tasks[0].args.indexOf("-i");
    assert.ok(index > 0, "argv must contain -i");
    assert.ok(!tasks[0].args.includes("-rtsp_transport"));
    // rtsps 同样属于 rtsp 族，需要携带 transport。
    await segmenter.stop();
    const { port: port2, tasks: tasks2 } = fakeExecutionPort();
    const segmenter2 = createFfmpegRtspSegmenter({ executionPort: port2, pollIntervalMs: 10 });
    await segmenter2.start(
      {
        sourceUrl: "rtsps://cam.local:322/live",
        outDir: dir,
        segmentSeconds: 3,
        transport: "tcp",
        trace: createRootTraceContext(),
      },
      { signal: undefined },
    );
    assert.ok(tasks2[0].args.includes("-rtsp_transport"));
    await segmenter2.stop();
  });

  it("跨重启编号单调：起始编号 = max(marker, 现存文件 max+1)", async () => {
    const { port, tasks } = fakeExecutionPort();
    const dir = await makeTempDir("zcode-rtsp-seqnum-");
    const segmenter = createFfmpegRtspSegmenter({ executionPort: port, pollIntervalMs: 10 });
    // 现存文件 seg00003（上次崩溃遗留）→ 从 4 继续，且 marker 同步落盘。
    await writeFile(join(dir, "seg00003.mp4"), Buffer.from([0]));
    await segmenter.start(
      {
        sourceUrl: "rtsp://user:***@cam.local:554/live",
        outDir: dir,
        segmentSeconds: 5,
        transport: "tcp",
        trace: createRootTraceContext(),
      },
      { signal: undefined },
    );
    const startNumberIndex = tasks[0].args.indexOf("-segment_start_number");
    assert.ok(startNumberIndex > 0, "argv must contain -segment_start_number");
    assert.equal(tasks[0].args[startNumberIndex + 1], "4");
    assert.equal(
      (await readFile(join(dir, SEGMENT_MARKER_FILE_NAME), "utf-8")).trim(),
      "4",
      "marker must be persisted at start before ffmpeg can crash",
    );
    await segmenter.stop();

    // 文件被清理后以 marker 为准（值 9 → 从 9 继续，不回卷到 0）。
    await rm(join(dir, "seg00003.mp4"), { force: true });
    await writeFile(join(dir, SEGMENT_MARKER_FILE_NAME), "9\n", "utf-8");
    const { port: port2, tasks: tasks2 } = fakeExecutionPort();
    const segmenter2 = createFfmpegRtspSegmenter({ executionPort: port2, pollIntervalMs: 10 });
    await segmenter2.start(
      {
        sourceUrl: "rtsp://user:***@cam.local:554/live",
        outDir: dir,
        segmentSeconds: 5,
        transport: "tcp",
        trace: createRootTraceContext(),
      },
      { signal: undefined },
    );
    const index2 = tasks2[0].args.indexOf("-segment_start_number");
    assert.equal(tasks2[0].args[index2 + 1], "9");
    await segmenter2.stop();

    // marker 落后于现存文件（写入与 marker 更新之间崩溃）→ 以文件为准。
    await writeFile(join(dir, "seg00011.mp4"), Buffer.from([0]));
    const { port: port3, tasks: tasks3 } = fakeExecutionPort();
    const segmenter3 = createFfmpegRtspSegmenter({ executionPort: port3, pollIntervalMs: 10 });
    await segmenter3.start(
      {
        sourceUrl: "rtsp://user:***@cam.local:554/live",
        outDir: dir,
        segmentSeconds: 5,
        transport: "tcp",
        trace: createRootTraceContext(),
      },
      { signal: undefined },
    );
    const index3 = tasks3[0].args.indexOf("-segment_start_number");
    assert.equal(tasks3[0].args[index3 + 1], "12");
    await segmenter3.stop();
  });

  it("关段后 marker 推进；deleteSegment 删除已处理文件", async () => {
    const dir = await makeTempDir("zcode-rtsp-marker-");
    const { port, tasks } = fakeExecutionPort();
    const segmenter = createFfmpegRtspSegmenter({ executionPort: port, pollIntervalMs: 5 });
    await segmenter.start(
      {
        sourceUrl: "rtsp://user:***@cam.local:554/live",
        outDir: dir,
        segmentSeconds: 5,
        transport: "tcp",
        trace: createRootTraceContext(),
      },
      { signal: undefined },
    );
    // 起始 marker=0：写 seg00000/seg00001 → seq 0 关闭 → marker 推进到 1。
    await writeFile(join(dir, "seg00000.mp4"), Buffer.from([0]));
    await writeFile(join(dir, "seg00001.mp4"), Buffer.from([0]));
    const controller = new AbortController();
    const yielded: number[] = [];
    const consume = (async () => {
      for await (const segment of segmenter.watchClosedSegments(controller.signal)) {
        yielded.push(segment.seq);
      }
    })();
    await waitFor(() => yielded.includes(0), 15_000);
    assert.equal((await readFile(join(dir, SEGMENT_MARKER_FILE_NAME), "utf-8")).trim(), "1");
    // deleteSegment：已处理文件删除后重启扫描不再看到它。
    await segmenter.deleteSegment(join(dir, "seg00000.mp4"));
    await expect(readFile(join(dir, "seg00000.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    tasks[0].running = false;
    await waitFor(() => yielded.includes(1), 15_000);
    await segmenter.stop();
    controller.abort();
    await consume;
  });

  it("ExecutionPort 不支持后台执行时抛 unavailable", async () => {
    const segmenter = createFfmpegRtspSegmenter({ executionPort: { run: async () => ({}) as never } });
    await expect(
      segmenter.start(
        {
          sourceUrl: "rtsp://user:***@cam.local:554/live",
          outDir: "/tmp/unused",
          segmentSeconds: 5,
          transport: "tcp",
          trace: createRootTraceContext(),
        },
        { signal: undefined },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
