import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STREAMS_CONFIG_PATH,
  loadStreamConfig,
  redactedStreamView,
  resolveStreamConfigPath,
  StreamConfigError,
  writeStreamConfig,
} from "../src/config/stream-config.adapter.js";

// fixture URL 统一用脱敏形态（安全红线：真实凭据不进测试文件）。
const FIXTURE_URL = "rtsp://user:***@cam.local:554/live";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveStreamConfigPath", () => {
  it("显式路径优先于环境变量与默认值", () => {
    expect(resolveStreamConfigPath("/tmp/streams.json", { ZCODE_STREAM_CONFIG: "/env.json" })).toBe(
      "/tmp/streams.json",
    );
  });

  it("环境变量次之", () => {
    expect(resolveStreamConfigPath(undefined, { ZCODE_STREAM_CONFIG: "/env.json" })).toBe("/env.json");
  });

  it("缺省回退 ~/.zcode/cli/streams.json", () => {
    expect(resolveStreamConfigPath(undefined, {})).toBe(DEFAULT_STREAMS_CONFIG_PATH);
  });
});

describe("loadStreamConfig", () => {
  it("不存在时抛 not_found 且提示示例结构", async () => {
    const dir = await makeTempDir("zcode-stream-cfg-missing-");
    const path = join(dir, "streams.json");
    await expect(loadStreamConfig(path)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("合法配置通过并归一默认值", async () => {
    const dir = await makeTempDir("zcode-stream-cfg-ok-");
    const path = join(dir, "streams.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, streams: [{ id: "front-door", url: FIXTURE_URL }] }),
    );
    const config = await loadStreamConfig(path);
    assert.equal(config.streams.length, 1);
    assert.equal(config.streams[0].transport, "tcp");
    assert.equal(config.streams[0].segmentSeconds, 30);
    assert.equal(config.streams[0].enabled, true);
  });

  it("拒绝非法 id / 非 stream url / 越界 segmentSeconds", async () => {
    const dir = await makeTempDir("zcode-stream-cfg-bad-");
    const cases = [
      { streams: [{ id: "bad id!", url: FIXTURE_URL }] },
      { streams: [{ id: "ok", url: "ftp://cam.local/live" }] },
      { streams: [{ id: "ok", url: FIXTURE_URL, segmentSeconds: 1 }] },
    ];
    for (const [index, doc] of cases.entries()) {
      const path = join(dir, `case-${index}.json`);
      await writeFile(path, JSON.stringify({ version: 1, ...doc }));
      await expect(loadStreamConfig(path)).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("rtmp / http-flv 等 network-stream URL 通过校验（2026-10-16 协议泛化）", async () => {
    const dir = await makeTempDir("zcode-stream-cfg-proto-");
    const cases = [
      "rtsp://cam.local:554/live",
      "rtsps://cam.local:322/live",
      "rtmp://cam.local:1935/live/stream",
      "rtmps://cam.local:1935/live/stream",
      "http://cam.local:48021/live/0.stream.flv",
      "https://cam.local/live/index.m3u8",
    ];
    for (const [index, url] of cases.entries()) {
      const path = join(dir, `case-${index}.json`);
      await writeFile(path, JSON.stringify({ version: 1, streams: [{ id: "cam", url }] }));
      const config = await loadStreamConfig(path);
      assert.equal(config.streams[0].url, url);
    }
  });

  it("重复 stream id 拒绝", async () => {
    const dir = await makeTempDir("zcode-stream-cfg-dup-");
    const path = join(dir, "streams.json");
    const stream = { id: "dup", url: FIXTURE_URL };
    await writeFile(path, JSON.stringify({ version: 1, streams: [stream, stream] }));
    await expect(loadStreamConfig(path)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("writeStreamConfig", () => {
  it("写入文件权限为 0600（POSIX）", async () => {
    const dir = await makeTempDir("zcode-stream-cfg-write-");
    const path = join(dir, "nested", "streams.json");
    await writeStreamConfig(path, [
      { id: "gate", url: FIXTURE_URL, transport: "tcp", segmentSeconds: 30, enabled: true },
    ]);
    const info = await stat(path);
    if (process.platform !== "win32") {
      assert.equal(info.mode & 0o777, 0o600);
    }
    // 回读一致（原子写后可读）。
    const config = await loadStreamConfig(path);
    assert.equal(config.streams[0].id, "gate");
  });
});

describe("redactedStreamView", () => {
  it("脱敏 view 不含原始 url 字段，password 被剥除", () => {
    const view = redactedStreamView({
      id: "gate",
      url: "rtsp://user:secret@cam.local:554/live",
      transport: "tcp",
      segmentSeconds: 30,
      enabled: true,
    });
    assert.equal(view.urlRedacted, "rtsp://cam.local:554/live");
    assert.equal("url" in view, false);
    assert.equal(JSON.stringify(view).includes("secret"), false);
  });
});
