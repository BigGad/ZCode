import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import { run, type RunDependencies } from "../src/run.js";
import type { CliShutdownProcess } from "../src/shutdown.js";

/**
 * --pdf-password 的 CLI 边界测试：
 * - 无头（-p/--target）下透传到 createZCodeApp 的 pdfPassword；
 * - 其他子命令入口拒绝（scope）；
 * - 空值拒绝。
 * 解锁语义由 core 的 runtime-pdf-password-port.test.ts 覆盖。
 */
function harness(argv: string[]) {
  const calls: string[] = [];
  const signalProcess = Object.assign(new EventEmitter(), { platform: "linux" as const });
  let stdout = "";
  let stderr = "";
  const ctx: RunContext = {
    argv,
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
  };
  const deps: RunDependencies = {
    skipUserConfig: true,
    loadDotenv: () => ({ keys: [], loaded: false }),
    startProcessProviderRegistryRuntime: async () =>
      ({
        runtime: { registryService: {} },
        dispose: () => calls.push("dispose"),
      }) as never,
    shutdownCleanupTimeoutMs: 10,
    shutdownProcess: signalProcess as CliShutdownProcess,
    exitProcess: (code) => {
      calls.push(`exit:${code}`);
    },
    createZCodeApp: (options) => {
      calls.push(`pdfPassword:${options?.pdfPassword}`);
      return {
        sessionId: "pdf-password-test",
        traceId: "pdf-password-trace",
        runtime: {},
        submitPrompt: async (
          _prompt: unknown,
          options?: { onEvent?: (event: unknown) => void },
        ) => {
          calls.push("main");
          options?.onEvent?.({ type: "turn.completed" });
          return {
            response: "main answer",
            events: [],
            projection: { status: "idle", turnCount: 1, totalTokenCount: 0 },
          };
        },
        close: async () => {
          calls.push("close");
        },
      } as never;
    },
  };
  return {
    calls,
    ctx,
    deps,
    signalProcess,
    output: () => ({ stdout, stderr }),
  };
}

test("--pdf-password reaches createZCodeApp on a headless prompt", async () => {
  const h = harness(["-p", "阅卷", "--pdf-password", "pw-12345"]);
  assert.equal(await run(h.ctx, h.deps), 0);
  assert.deepEqual(h.calls, ["pdfPassword:pw-12345", "main", "close", "dispose"]);
});

test("--pdf-password reaches createZCodeApp on a headless target run", async () => {
  const h = harness(["--target", "阅卷", "--pdf-password", "pw-12345"]);
  assert.equal(await run(h.ctx, h.deps), 0);
  // --target 被包装成 /goal 命令，走 command-center 路径、不经过 submitPrompt；
  // 这里只验证 scope 放行与 pdfPassword 透传到 createZCodeApp。
  assert.equal(h.calls[0], "pdfPassword:pw-12345");
  assert.ok(h.calls.includes("close"));
});

test("prompt without --pdf-password passes no pdfPassword", async () => {
  const h = harness(["-p", "阅卷"]);
  assert.equal(await run(h.ctx, h.deps), 0);
  assert.deepEqual(h.calls, ["pdfPassword:undefined", "main", "close", "dispose"]);
});

for (const argv of [[], ["tui"], ["app-server"], ["agent-server"]]) {
  test(`--pdf-password rejects unsupported invocation ${JSON.stringify(argv)}`, async () => {
    const h = harness([...argv, "--pdf-password", "pw-12345"]);
    assert.equal(await run(h.ctx, h.deps), 1);
    assert.match(h.output().stderr, /--pdf-password.*--prompt/);
    assert.deepEqual(h.calls, []);
  });
}

test("--pdf-password rejects an empty value", async () => {
  const h = harness(["-p", "阅卷", "--pdf-password", "   "]);
  assert.equal(await run(h.ctx, h.deps), 1);
  assert.match(h.output().stderr, /--pdf-password requires non-empty text/);
  assert.deepEqual(h.calls, []);
});

test("`zcode ocr` is exempt from the headless --pdf-password scope", async () => {
  // ⚠️ 回归：`zcode ocr parse` **自己**消费 `--pdf-password`（spec：
  // capability-cli-blocks.md D16 / ocr-local.md §3.2.1）。全局作用域检查只管
  // **无头链路**（-p/--target），不能把 ocr 命令组一起拦掉 ——
  // 否则 flag 收得到却用不了（实测过一次：报「--pdf-password can only be used
  // with --prompt or --target.」）。
  const h = harness([
    "ocr",
    "parse",
    "--path",
    "/tmp/zcode-missing-pdf.pdf",
    "--pdf-password",
    "pw-12345",
    "--json",
  ]);
  const exitCode = await run(h.ctx, h.deps);
  const { stdout, stderr } = h.output();

  assert.doesNotMatch(stderr, /--pdf-password.*--prompt/u);
  // ⚠️ 走到 parse 分支了（文件不存在 ⇒ not_found 信封，退出码 1）。
  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stdout) as { key: string; ok: boolean; error?: { code?: string } };
  assert.equal(envelope.key, "ocr.parse");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "not_found");
  // ⚠️ 密码**绝不出现在输出里**。
  assert.doesNotMatch(stdout, /pw-12345/u);
  assert.doesNotMatch(stderr, /pw-12345/u);
});
