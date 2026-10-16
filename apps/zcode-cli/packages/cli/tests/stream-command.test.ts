import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import { runStreamCommand } from "../src/stream-command.js";
import { parseWatchDeadline } from "../src/stream-watch-daemon.js";

type CapturedWriteStream = NodeJS.WriteStream & { output(): string };

function stream(): CapturedWriteStream {
  let output = "";
  const writable = {
    write: (chunk: string) => {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return Object.assign(writable, { output: () => output });
}

function context(): { ctx: RunContext; stdout: CapturedWriteStream; stderr: CapturedWriteStream } {
  const stdout = stream();
  const stderr = stream();
  return { ctx: { stdout, stderr } as unknown as RunContext, stdout, stderr };
}

const globalOptions = {
  force: false,
  json: false,
  noColor: true,
  verbose: false,
};

// fixture URL 用脱敏形态（安全红线：真实凭据不进测试文件）。
const FIXTURE_URL = "rtsp://user:***@cam.local:554/live";

test("stream list 输出脱敏 view，不含密码", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-stream-cmd-list-"));
  try {
    const configPath = join(dir, "streams.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        streams: [{ id: "gate", url: FIXTURE_URL, title: "大门" }],
      }),
    );
    const { ctx, stdout } = context();
    const exit = await runStreamCommand(
      ctx,
      globalOptions,
      { subcommand: "list", config: configPath },
    );
    assert.equal(exit, 0);
    assert.ok(stdout.output().includes("gate"));
    assert.ok(stdout.output().includes("大门"));
    assert.ok(!stdout.output().includes("secret"), "password must not appear");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stream list --json 输出 NDJSON 且不含原始 url 字段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-stream-cmd-json-"));
  try {
    const configPath = join(dir, "streams.json");
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, streams: [{ id: "gate", url: FIXTURE_URL }] }),
    );
    const { ctx, stdout } = context();
    const exit = await runStreamCommand(
      ctx,
      { ...globalOptions, json: true },
      { subcommand: "list", config: configPath },
    );
    assert.equal(exit, 0);
    const parsed = JSON.parse(stdout.output().trim()) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, "gate");
    assert.equal("url" in parsed[0], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("未知子命令退出码 1", async () => {
  const { ctx, stderr } = context();
  const exit = await runStreamCommand(ctx, globalOptions, { subcommand: "nope" });
  assert.equal(exit, 1);
  assert.ok(stderr.output().includes("Unknown stream subcommand"));
});

test("events：合法 stream id 且无事件文件时输出为空、退出码 0", async () => {
  const { ctx, stdout } = context();
  const exit = await runStreamCommand(ctx, globalOptions, {
    subcommand: "events",
    stream: "gate",
  });
  assert.equal(exit, 0);
  assert.equal(stdout.output(), "");
});

test("events：非法 stream id 退出码 1（拒绝路径注入）", async () => {
  const { ctx, stderr } = context();
  const exit = await runStreamCommand(ctx, globalOptions, {
    subcommand: "events",
    stream: "../escape",
  });
  assert.equal(exit, 1);
  assert.ok(stderr.output().length > 0);
});

test("events：未指定 --stream 退出码 1", async () => {
  const { ctx, stderr } = context();
  const exit = await runStreamCommand(ctx, globalOptions, { subcommand: "events" });
  assert.equal(exit, 1);
  assert.ok(stderr.output().includes("--stream"));
});

test("parseWatchDeadline：duration/until 解析与互斥校验", async () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(parseWatchDeadline({ duration: "30m", now }), now + 30 * 60_000);
  assert.equal(parseWatchDeadline({ duration: "2h", now }), now + 2 * 3_600_000);
  assert.equal(parseWatchDeadline({ duration: "90", now }), now + 90_000);
  assert.equal(parseWatchDeadline({ until: String(now + 60_000), now }), now + 60_000);
  assert.equal(parseWatchDeadline({ until: "2026-10-16T13:00:00Z", now }), Date.parse("2026-10-16T13:00:00Z"));
  assert.equal(parseWatchDeadline({ now }), undefined);
  assert.throws(() => parseWatchDeadline({ duration: "2h", until: String(now), now }), /mutually exclusive/);
  assert.throws(() => parseWatchDeadline({ duration: "abc", now }), /Invalid --duration/);
  assert.throws(() => parseWatchDeadline({ until: "not-a-time", now }), /Invalid --until/);
  assert.throws(() => parseWatchDeadline({ until: String(now - 1_000), now }), /in the past/);
});

test("analyze 不接受 --duration/--until/--forever（仅 watch 支持）", async () => {
  const { ctx, stderr } = context();
  const exit = await runStreamCommand(ctx, globalOptions, {
    subcommand: "analyze",
    once: true,
    stream: "gate",
    duration: "2h",
  });
  assert.equal(exit, 1);
  assert.ok(stderr.output().includes("only supported with"));
});

test("stop：未在运行时退出码 1 并提示", async () => {
  const { ctx, stdout } = context();
  const exit = await runStreamCommand(ctx, globalOptions, {
    subcommand: "stop",
    stream: "no-such-daemon-stream",
  });
  assert.equal(exit, 1);
  assert.ok(stdout.output().includes("not running"));
});
