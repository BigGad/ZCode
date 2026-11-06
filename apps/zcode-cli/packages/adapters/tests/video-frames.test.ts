import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRootTraceContext } from "@zcode/contracts";

import {
  createFfmpegVideoFrameAdapter,
  probeFfmpegAvailable,
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
