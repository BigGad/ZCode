import assert from "node:assert/strict";
import test from "node:test";
import type {
  LocalInfraDoctorReport,
  LocalInfraPort,
  LocalModelsDownloadRequest,
  LocalModelsDownloadResult,
  LocalParseRequest,
  LocalParseResult,
} from "@zcode/contracts";
import { runInfrManage } from "../src/infr-manage/index.js";

/**
 * `zcode-infr-manage` 命令面（spec: `docs/design/v2/local-infra.md` §7.3 / §7.6 / §8）。
 *
 * 这里只测**命令面契约**（参数解析、stdout 形状、退出码、错误码归一），
 * 端口层的档位判定 / 产物分类等在 `packages/adapters/tests/local-infra/` 里测。
 */

interface CapturedStream {
  write(chunk: string): unknown;
  output(): string;
}

function stream(): CapturedStream {
  let output = "";
  const writable = {
    write: (chunk: string) => {
      output += chunk;
      return true;
    },
  };
  return Object.assign(writable, { output: () => output });
}

interface Captured {
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
}

function captured(): Captured {
  return { stdout: stream(), stderr: stream() };
}

/** 假端口：只记录调用，按预设返回结果。 */
interface StubPort {
  readonly port: LocalInfraPort;
  readonly parseCalls: LocalParseRequest[];
  readonly downloadCalls: LocalModelsDownloadRequest[];
}

function stubPort(options: {
  readonly doctor?: LocalInfraDoctorReport;
  readonly parse?: LocalParseResult;
  readonly download?: LocalModelsDownloadResult;
}): StubPort {
  const parseCalls: LocalParseRequest[] = [];
  const downloadCalls: LocalModelsDownloadRequest[] = [];

  const port: LocalInfraPort = {
    async doctor() {
      return (
        options.doctor ?? {
          engines: [
            {
              engine: "mineru",
              available: false,
              versionToolAvailable: false,
              reason: "未找到 mineru-kit 可执行文件",
              fix: 'uv tool install --python 3.12 "mineru>=4.0,<5"',
            },
          ],
          supportedTiers: [],
          models: [],
          weightsFetched: false,
          durationMs: 3,
        }
      );
    },
    async parse(request) {
      parseCalls.push(request);
      return (
        options.parse ?? {
          ok: true,
          engine: "mineru",
          tier: "basic",
          output: {
            outputDir: "/tmp/out",
            markdownPath: "/tmp/out/markdown.md",
          },
          warnings: [],
          durationMs: 12,
        }
      );
    },
    async downloadModels(request) {
      downloadCalls.push(request);
      return (
        options.download ?? {
          ok: true,
          engine: "mineru",
          tier: "basic",
          warnings: [],
          durationMs: 20,
          stdout: "已下载 1 个仓库。\n",
        }
      );
    },
  };

  return { port, parseCalls, downloadCalls };
}

async function run(
  argv: readonly string[],
  options: {
    readonly doctor?: LocalInfraDoctorReport;
    readonly parse?: LocalParseResult;
    readonly download?: LocalModelsDownloadResult;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; stub: StubPort }> {
  const out = captured();
  const stub = stubPort(options);
  const exitCode = await runInfrManage({ stdout: out.stdout, stderr: out.stderr }, argv, {
    createRuntime: () => ({ port: stub.port }),
  });
  return { exitCode, stdout: out.stdout.output(), stderr: out.stderr.output(), stub };
}

test("--help 输出用法且退出码为 0", async () => {
  const result = await run(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /zcode-infr-manage/);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /parse/);
  assert.match(result.stdout, /models download/);
});

test("未知旗标与未知命令都退出码 1，错误写 stderr", async () => {
  const unknownFlag = await run(["doctor", "--verbose"]);
  assert.equal(unknownFlag.exitCode, 1);
  assert.match(unknownFlag.stderr, /未知旗标/);

  const unknownCommand = await run(["explode"]);
  assert.equal(unknownCommand.exitCode, 1);
  assert.match(unknownCommand.stderr, /未知命令/);
});

test("A4: 档位原样透传给端口，CLI 不做预校验", async () => {
  // CLI 预校验会让「非法档位」的内部码出不来（端口才判定 engine_not_found），
  // 所以这里断言 CLI 把 `turbo` 原样递下去。
  const result = await run(["parse", "--path", "/tmp/a.pdf", "--tier", "turbo"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stub.parseCalls[0]?.tier, "turbo" as never);
});

test("A4: 端口报 engine_not_found 时对外归一为 invalid_input 且带 engineCode", async () => {
  const result = await run(["parse", "--path", "/tmp/a.pdf", "--tier", "turbo", "--json"], {
    parse: {
      ok: false,
      error: {
        code: "engine_not_found",
        message: "未知的解析档位：turbo",
        hint: "可用档位：flash、basic、standard、advanced",
        details: { engineCode: "engine_not_found", tier: "turbo" },
      },
      warnings: [],
      durationMs: 1,
    },
  });

  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string; message: string; details: Record<string, unknown> };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "invalid_input");
  assert.equal(payload.error.details.engineCode, "engine_not_found");
});

test("A5: 产物缺失归一为 internal + engineCode=artifact_missing，退出码 1", async () => {
  const result = await run(["parse", "--path", "/tmp/a.pdf", "--json"], {
    parse: {
      ok: false,
      error: {
        code: "artifact_missing",
        message: "引擎退出码为 0，但没有产出结果文件",
        details: { engineCode: "artifact_missing" },
      },
      warnings: [],
      durationMs: 1,
    },
  });

  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as {
    error: { code: string; details: Record<string, unknown> };
  };
  assert.equal(payload.error.code, "internal");
  assert.equal(payload.error.details.engineCode, "artifact_missing");
});

test("A6: 引擎失败归一为 internal + engineCode=process_failed，退出码 1", async () => {
  const result = await run(["parse", "--path", "/tmp/a.pdf", "--json"], {
    parse: {
      ok: false,
      error: {
        code: "process_failed",
        message: "引擎执行失败（退出码 3）",
        hint: "CUDA out of memory",
        details: { engineCode: "process_failed", exitCode: 3 },
      },
      warnings: [],
      durationMs: 1,
    },
  });

  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as { error: { code: string; hint: string } };
  assert.equal(payload.error.code, "internal");
  assert.equal(payload.error.hint, "CUDA out of memory");
});

test("超时退出码是 124", async () => {
  const result = await run(["parse", "--path", "/tmp/a.pdf", "--json"], {
    parse: {
      ok: false,
      error: {
        code: "timeout",
        message: "解析超时（600s）",
        details: { engineCode: "timeout" },
      },
      warnings: [],
      durationMs: 1,
    },
  });

  assert.equal(result.exitCode, 124);
  const payload = JSON.parse(result.stdout) as { error: { code: string } };
  assert.equal(payload.error.code, "timeout");
});

test("输入文件不存在归一为 not_found", async () => {
  const result = await run(["parse", "--path", "/tmp/missing.pdf", "--json"], {
    parse: {
      ok: false,
      error: {
        code: "input_invalid",
        message: "文件不存在：/tmp/missing.pdf",
        details: { engineCode: "input_invalid", reason: "not_found" },
      },
      warnings: [],
      durationMs: 1,
    },
  });

  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as { error: { code: string } };
  assert.equal(payload.error.code, "not_found");
});

test("A10: --json 时 stdout 是单个 JSON 对象，引擎输出只在 stderr", async () => {
  const result = await run(["parse", "--path", "/tmp/a.pdf", "--json"], {
    parse: {
      ok: true,
      engine: "mineru",
      tier: "basic",
      output: { outputDir: "/tmp/out", markdownPath: "/tmp/out/markdown.md" },
      warnings: [],
      durationMs: 12,
      stdout: "已解析 1 个输入。\n",
    },
  });

  assert.equal(result.exitCode, 0);
  // stdout 是**单个** JSON 对象：整段能解析成一个对象，且对象里没有混入引擎文本。
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(typeof payload, "object");
  assert.equal(payload.ok, true);
  assert.equal(payload.tier, "basic");
  assert.ok(!result.stdout.includes("已解析 1 个输入。"), "引擎输出不得混进 stdout");
  // 进度信息走 stderr。
  assert.match(result.stderr, /已解析 1 个输入。/);
});

test("A10: 非 JSON 模式输出人读报告，引擎输出仍然只在 stderr", async () => {
  const result = await run(["parse", "--path", "/tmp/a.pdf"], {
    parse: {
      ok: true,
      engine: "mineru",
      tier: "basic",
      output: { outputDir: "/tmp/out", markdownPath: "/tmp/out/markdown.md" },
      warnings: [],
      durationMs: 12,
      stdout: "已解析 1 个输入。\n",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /解析成功/);
  assert.match(result.stdout, /\/tmp\/out\/markdown\.md/);
  assert.ok(!result.stdout.includes("已解析 1 个输入。"));
  assert.match(result.stderr, /已解析 1 个输入。/);
});

test("doctor --json 输出体检报告，引擎不可用也退出码 0", async () => {
  const result = await run(["doctor", "--json"]);

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as {
    engines: { available: boolean; reason?: string; fix?: string }[];
    weightsFetched: boolean;
  };
  assert.equal(payload.engines.length, 1);
  assert.equal(payload.engines[0]?.available, false);
  assert.ok(payload.engines[0]?.reason);
  assert.ok(payload.engines[0]?.fix);
  assert.equal(payload.weightsFetched, false);
});

test("doctor 人读模式写明「本地解析引擎体检」", async () => {
  const result = await run(["doctor"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /本地解析引擎体检/);
  assert.match(result.stdout, /本次体检未下载任何权重。/);
});

test("models download 只接受 basic / standard，其它档位退出码 1", async () => {
  const rejected = await run(["models", "download", "--tier", "advanced", "--json"]);
  assert.equal(rejected.exitCode, 1);
  const payload = JSON.parse(rejected.stdout) as {
    ok: boolean;
    error: { code: string; details: Record<string, unknown> };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "invalid_input");
  assert.equal(payload.error.details.engineCode, "engine_not_found");
  assert.equal(rejected.stub.downloadCalls.length, 0);

  const accepted = await run(["models", "download", "--tier", "basic"]);
  assert.equal(accepted.exitCode, 0);
  assert.equal(accepted.stub.downloadCalls[0]?.tier, "basic");
});

test("models download 的引擎输出只走 stderr，不混进 stdout 的 JSON", async () => {
  const result = await run(["models", "download", "--tier", "basic", "--json"], {
    download: {
      ok: true,
      engine: "mineru",
      tier: "basic",
      warnings: [],
      durationMs: 20,
      stdout: "已下载 1 个仓库。\n",
    },
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.ok, true);
  assert.ok(!result.stdout.includes("已下载 1 个仓库。"));
  assert.match(result.stderr, /已下载 1 个仓库。/);
});
