import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ImageProcessorPort,
  ToolArtifactStorePort,
  VideoFramePort,
  WorkspaceResourceIndexEntry,
  WorkspaceResourceIndexPort,
} from "@zcode/contracts";
import {
  createStreamMonitor,
  type StreamMonitor,
} from "../src/runtime/stream-monitor/monitor-loop.js";
import {
  advanceWatchState,
  createInitialWatchState,
  createStreamWatchStateStore,
} from "../src/runtime/stream-monitor/watch-state.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface HarnessInput {
  segments: Array<{ seq: number; path: string }>;
  stateDir: string;
  eventsDir: string;
  /** 按分析调用次序给响应；undefined 回退默认 normal。 */
  analysisResponses?: string[];
  analysisError?: Error;
}

interface Harness {
  monitor: StreamMonitor;
  upsertedEntryIds: string[];
  analysisPrompts: string[];
  deletedUris: string[];
  deletedSegments: string[];
  getAnalysisCalls(): number;
}

/** 全 fake 注入；capture 一次性喂入 segments 后结束（capture 进程退出 → 重连语义）。 */
function buildHarness(input: HarnessInput): Harness {
  const upsertedEntryIds: string[] = [];
  const analysisPrompts: string[] = [];
  const deletedUris: string[] = [];
  const deletedSegments: string[] = [];
  let analysisCalls = 0;

  const videoFramePort = {
    extractFrames: async () => ({
      frames: [
        { timeMs: 0, imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==", width: 64, height: 48 },
      ],
    }),
  } as unknown as VideoFramePort;
  const imageProcessorPort = {
    prepareForModel: async (request: { data: Uint8Array }) => ({ data: request.data }),
  } as unknown as ImageProcessorPort;
  const artifactStore = {
    writeToolResultBinaryArtifact: async () => ({
      uri: `zcode-artifact://seg-${upsertedEntryIds.length}`,
    }),
    deleteToolResultArtifact: async (request: { uri: string }) => {
      deletedUris.push(request.uri);
      return { deleted: true };
    },
  } as unknown as ToolArtifactStorePort;
  const entries = new Map<string, WorkspaceResourceIndexEntry>();
  const workspaceResourceIndex = {
    getById: async (_key: string, id: string) => entries.get(id),
    upsert: async (entry: WorkspaceResourceIndexEntry) => {
      entries.set(entry.id, entry);
      upsertedEntryIds.push(entry.id);
      return entry;
    },
  } as unknown as WorkspaceResourceIndexPort;

  const monitor = createStreamMonitor({
    stream: {
      id: "gate",
      url: "rtsp://user:***@cam.local/live",
      transport: "tcp",
      segmentSeconds: 5,
    },
    monitorId: "stream-gate",
    workspaceKey: "/ws",
    workspacePath: "/ws",
    stateDir: input.stateDir,
    alertStoreDir: input.eventsDir,
    capture: {
      start: async () => undefined,
      watchClosedSegments: (signal: AbortSignal) =>
        (async function* () {
          for (const segment of input.segments) {
            if (signal.aborted) return;
            yield segment;
          }
        })(),
      readSegment: async () => new Uint8Array([1]),
      deleteSegment: async (path: string) => {
        deletedSegments.push(path);
      },
      stop: async () => undefined,
    },
    pipeline: {
      videoFramePort,
      imageProcessorPort,
      artifactStore,
      workspaceResourceIndex,
      workspaceKey: "/ws",
      workspacePath: "/ws",
    },
    runAnalysisTurn: async (req) => {
      analysisCalls += 1;
      analysisPrompts.push(req.prompt);
      if (input.analysisError !== undefined) throw input.analysisError;
      return input.analysisResponses?.shift() ?? '{"status":"normal","reason":"画面正常"}';
    },
    reconnectDelaysMs: [1],
  });

  return {
    monitor,
    upsertedEntryIds,
    analysisPrompts,
    deletedUris,
    deletedSegments,
    getAnalysisCalls: () => analysisCalls,
  };
}

async function makeDirs(prefix: string): Promise<{ stateDir: string; eventsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return { stateDir: join(dir, "state"), eventsDir: join(dir, "events") };
}

/** 轮询至条件满足（持续监控是长驻进程，测试用条件等待 + abort 收尾）。 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("stream monitor loop", () => {
  it("正常链路：segment → 抽帧 → 分析 → 判定落盘 → 游标推进", async () => {
    const { stateDir, eventsDir } = await makeDirs("zcode-stream-loop-");
    const { monitor, upsertedEntryIds, getAnalysisCalls, deletedSegments } = buildHarness({
      segments: [
        { seq: 0, path: "/tmp/seg0.mp4" },
        { seq: 1, path: "/tmp/seg1.mp4" },
      ],
      stateDir,
      eventsDir,
    });
    const controller = new AbortController();
    const runPromise = monitor.run(controller.signal);
    await waitFor(() => upsertedEntryIds.length === 2);
    await waitFor(() => getAnalysisCalls() === 2);
    controller.abort();
    await runPromise;
    expect(upsertedEntryIds).toEqual(["stream-gate-000000", "stream-gate-000001"]);
    // 处理成功后删除原始 segment 文件（长驻 watch 防磁盘无限增长）。
    expect(deletedSegments).toEqual(["/tmp/seg0.mp4", "/tmp/seg1.mp4"]);
    const verdicts = (await monitor.alerts.query({})).filter((row) => row.status === "normal");
    expect(verdicts).toHaveLength(2);
  });

  it("分析 turn 失败写 analysis_failed，不阻塞后续 segment", async () => {
    const { stateDir, eventsDir } = await makeDirs("zcode-stream-loop-fail-");
    const { monitor, upsertedEntryIds } = buildHarness({
      segments: [
        { seq: 0, path: "/tmp/seg0.mp4" },
        { seq: 1, path: "/tmp/seg1.mp4" },
      ],
      stateDir,
      eventsDir,
      analysisError: new Error("provider down"),
    });
    const controller = new AbortController();
    const runPromise = monitor.run(controller.signal);
    await waitFor(() => upsertedEntryIds.length === 2);
    await waitFor(async () => (await monitor.alerts.query({ status: "analysis_failed" })).length === 2);
    controller.abort();
    await runPromise;
  });

  it("幻觉判定输出（无 JSON）→ analysis_failed", async () => {
    const { stateDir, eventsDir } = await makeDirs("zcode-stream-loop-halluc-");
    const { monitor, getAnalysisCalls } = buildHarness({
      segments: [{ seq: 0, path: "/tmp/seg0.mp4" }],
      stateDir,
      eventsDir,
      analysisResponses: ["我看到了异常情况，画面中有人。"],
    });
    const controller = new AbortController();
    const runPromise = monitor.run(controller.signal);
    await waitFor(() => getAnalysisCalls() === 1);
    await waitFor(async () => (await monitor.alerts.query({ status: "analysis_failed" })).length === 1);
    controller.abort();
    await runPromise;
  });

  it("崩溃重启重放：cursor 之后（含未处理段）才重新处理", async () => {
    const { stateDir, eventsDir } = await makeDirs("zcode-stream-loop-replay-");
    // 第一次：处理 seq 0 后游标停在这里。
    const first = buildHarness({ segments: [{ seq: 0, path: "/tmp/seg0.mp4" }], stateDir, eventsDir });
    const firstController = new AbortController();
    const firstRun = first.monitor.run(firstController.signal);
    await waitFor(() => first.upsertedEntryIds.length === 1);
    firstController.abort();
    await firstRun;
    expect(first.upsertedEntryIds).toEqual(["stream-gate-000000"]);

    // 重启后重放 seq 0（capture 重扫）+ 新段 seq 1：seq 0 被幂等门跳过。
    const second = buildHarness({
      segments: [
        { seq: 0, path: "/tmp/seg0.mp4" },
        { seq: 1, path: "/tmp/seg1.mp4" },
      ],
      stateDir,
      eventsDir,
    });
    const secondController = new AbortController();
    const secondRun = second.monitor.run(secondController.signal);
    await waitFor(() => second.upsertedEntryIds.length >= 1);
    await waitFor(() => second.getAnalysisCalls() >= 1);
    secondController.abort();
    await secondRun;
    expect(second.upsertedEntryIds).toEqual(["stream-gate-000001"]);
    // 告警按 (streamId, segmentSeq) 去重：seq 0 不产生第二条 analysis 行。
    const analysisRows = (await second.monitor.alerts.query({})).filter(
      (row) => row.kind === "analysis",
    );
    expect(analysisRows.filter((row) => row.segmentSeq === 0)).toHaveLength(1);
  });

  it("artifact 保留窗口：超出 10 个后清理最旧 segment artifact", async () => {
    const { stateDir, eventsDir } = await makeDirs("zcode-stream-loop-gc-");
    const { monitor, deletedUris } = buildHarness({
      segments: Array.from({ length: 12 }, (_, seq) => ({ seq, path: `/tmp/seg${seq}.mp4` })),
      stateDir,
      eventsDir,
    });
    const controller = new AbortController();
    const runPromise = monitor.run(controller.signal);
    await waitFor(() => deletedUris.length === 2);
    controller.abort();
    await runPromise;
    // seq 0、1 被挤出保留窗口 → 其 artifact 被删除。
    expect(deletedUris).toHaveLength(2);
  });

  it("abort 立即停止循环", async () => {
    const { stateDir, eventsDir } = await makeDirs("zcode-stream-loop-abort-");
    const { monitor, upsertedEntryIds } = buildHarness({
      segments: Array.from({ length: 50 }, (_, seq) => ({ seq, path: `/tmp/seg${seq}.mp4` })),
      stateDir,
      eventsDir,
    });
    const controller = new AbortController();
    const runPromise = monitor.run(controller.signal);
    await waitFor(() => upsertedEntryIds.length >= 1);
    controller.abort();
    await runPromise;
    expect(upsertedEntryIds.length).toBeLessThan(50);
  });

  it("重启 gap 检测：距上次活动超过一个 segment 周期写 gap 事件", async () => {
    const { stateDir, eventsDir } = await makeDirs("zcode-stream-loop-gap-");
    // 预置一个 10 分钟前的游标（模拟 kill -9 后的宕机窗口）。
    const seedStore = createStreamWatchStateStore({
      stateDir,
      monitorId: "stream-gate",
      streamId: "gate",
    });
    const seeded = createInitialWatchState("stream-gate", "gate");
    advanceWatchState(seeded, { seq: 0, entryId: "stream-gate-000000" });
    await seedStore.save(seeded);
    // save() 会把 updatedAt 重置为当前时钟，宕机窗口只能在落盘后注入。
    const statePath = join(stateDir, "watch-state.json");
    const { readFile, writeFile } = await import("node:fs/promises");
    const persisted = JSON.parse(await readFile(statePath, "utf-8")) as { updatedAt: number };
    persisted.updatedAt = Date.now() - 10 * 60_000;
    await writeFile(statePath, JSON.stringify(persisted));

    const { monitor } = buildHarness({
      segments: [{ seq: 1, path: "/tmp/seg1.mp4" }],
      stateDir,
      eventsDir,
    });
    const controller = new AbortController();
    const runPromise = monitor.run(controller.signal);
    await waitFor(async () => (await monitor.alerts.query({ status: "gap" })).length === 1);
    controller.abort();
    await runPromise;
    const gapRow = (await monitor.alerts.query({ status: "gap" }))[0];
    expect(gapRow.kind).toBe("lifecycle");
    // gap 不影响幂等门：游标之后的 seq 1 照常处理。
    await waitFor(async () => (await monitor.alerts.query({ status: "normal" })).length === 1);
  });

  it("capture 反复失败达阈值 → stream_down 一次（状态翻转去重）", async () => {
    const { stateDir, eventsDir } = await makeDirs("zcode-stream-loop-down-");
    let attempts = 0;
    const streamDownRows: unknown[] = [];
    const monitor = createStreamMonitor({
      stream: {
        id: "gate",
        url: "rtsp://user:***@cam.local/live",
        transport: "tcp",
        segmentSeconds: 5,
      },
      monitorId: "stream-gate",
      workspaceKey: "/ws",
      workspacePath: "/ws",
      stateDir,
      alertStoreDir: eventsDir,
      capture: {
        start: async () => {
          attempts += 1;
          throw new Error("connect refused");
        },
        watchClosedSegments: () =>
          (async function* () {
            /* never */
          })(),
        readSegment: async () => new Uint8Array(),
        stop: async () => undefined,
      },
      pipeline: {
        videoFramePort: {} as VideoFramePort,
        imageProcessorPort: {} as ImageProcessorPort,
        artifactStore: {} as ToolArtifactStorePort,
        workspaceResourceIndex: {} as WorkspaceResourceIndexPort,
        workspaceKey: "/ws",
        workspacePath: "/ws",
      },
      runAnalysisTurn: async () => {
        throw new Error("not expected");
      },
      reconnectDelaysMs: [1],
      onAlert: (alert) => {
        if (alert.status === "stream_down") streamDownRows.push(alert);
      },
    });
    const controller = new AbortController();
    const runPromise = monitor.run(controller.signal);
    await waitFor(() => streamDownRows.length === 1);
    const attemptsAtDown = attempts;
    controller.abort();
    await runPromise;
    expect(attemptsAtDown).toBeGreaterThanOrEqual(3);
    expect(streamDownRows).toHaveLength(1);
  });
});
