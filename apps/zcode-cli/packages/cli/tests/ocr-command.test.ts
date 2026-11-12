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
import type { RunContext } from "@zcode/shared-types";
import { runOcrCommand } from "../src/ocr/index.js";
import type { OcrCommandInput } from "../src/ocr/arguments.js";
import { run as runCli } from "../src/run.js";
import { MemoryFileSystem } from "./fixtures/memory-file-system.js";

/**
 * `zcode ocr` 命令面（spec：`docs/design/v2/capability-cli-blocks.md` §5 / §6，
 * 以及 `docs/design/v2/local-infra.md` §7.3 / §7.6 / §8）。
 *
 * 这里只测**命令面契约**（组合校验、统一信封、stdout/stderr 分流、退出码、
 * 错误码归一、sidecar 缓存与接力），端口层的档位判定 / 产物分类等在
 * `packages/adapters/tests/local-infra/` 里测。
 *
 * ⚠️ **旗标由 `zcode` 的全局解析器解析**（严格解析器要求全局注册），
 * 本组只做组合校验 ⇒ 这里直接构造 `OcrCommandInput`，
 * 全局解析与分派的接线由文末的「接线」用例覆盖。
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
      return options.parse ?? successfulParseResult();
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

/** 源文件（sidecar 写在它旁边）。 */
const SOURCE_PATH = "/tmp/work/report.pdf";
/** 产物目录。 */
const ARTIFACTS_DIR = "/tmp/work/report.pdf.mineru";
/** sidecar 落盘位置。 */
const SIDECAR_PATH = "/tmp/work/report.pdf.zcode-ocr.json";

/** 默认的解析结果：**带元素级模型**（sidecar 的前提）。 */
function successfulParseResult(): LocalParseResult {
  return {
    ok: true,
    engine: "mineru",
    tier: "basic",
    output: {
      outputDir: ARTIFACTS_DIR,
      markdownPath: `${ARTIFACTS_DIR}/report.md`,
      structuredContentPath: `${ARTIFACTS_DIR}/structured_content.json`,
      assetsDir: `${ARTIFACTS_DIR}/images`,
      documentModel: {
        pages: [
          {
            pageIndex: 0,
            widthPt: 595,
            heightPt: 842,
            status: "ok",
            elements: [
              { type: "text", bbox: [10, 20, 300, 40], text: "第一段" },
              { type: "image", bbox: [10, 50, 200, 150], imagePath: "images/p0.jpg" },
            ],
          },
        ],
        producer: { name: "mineru", version: "4.1.7" },
      },
    },
    warnings: [],
    durationMs: 12,
  };
}

/**
 * 原生分析路线的解析结果（`route = "pdf-native"`）。
 *
 * ⚠️ **没有 `markdownPath`** —— 原生路线没有引擎产物，markdown 由 ZCode 从元素派生。
 */
function nativeParseResult(): LocalParseResult {
  return {
    ok: true,
    route: "pdf-native",
    output: {
      outputDir: ARTIFACTS_DIR,
      documentModel: {
        pages: [
          {
            pageIndex: 0,
            widthPt: 595,
            heightPt: 842,
            status: "ok",
            elements: [
              { type: "text", bbox: [0.1, 0.02, 0.38, 0.03], text: "本地 OCR 路线验证" },
              { type: "image", bbox: [0.08, 0.12, 0.42, 0.3], imagePath: "layout-1_1.png" },
            ],
          },
        ],
        producer: { name: "pdf-native", version: "26.09.0" },
      },
    },
    warnings: ["文档每一页都有文本层，走 PDF 原生分析路线（不消耗模型权重）"],
    durationMs: 8,
  };
}

/** 构造命令组输入：位置参数 + 旗标 + `--json` / `--help`。 */
function input(
  positionals: readonly string[],
  flags: OcrCommandInput["flags"] = {},
  extra: { readonly json?: boolean; readonly help?: boolean } = {},
): OcrCommandInput {
  return {
    positionals,
    flags,
    json: extra.json === true,
    help: extra.help === true,
  };
}

/** 一个带源文件的内存文件系统。 */
function fileSystemWithSource(): MemoryFileSystem {
  const fileSystem = new MemoryFileSystem();
  fileSystem.files.set(SOURCE_PATH, "PDF-CONTENT");
  return fileSystem;
}

async function runOcr(
  commandInput: OcrCommandInput,
  options: {
    readonly doctor?: LocalInfraDoctorReport;
    readonly parse?: LocalParseResult;
    readonly download?: LocalModelsDownloadResult;
    readonly fileSystem?: MemoryFileSystem;
    /** 复用同一个假端口（多次调用时用来统计引擎被调了几次）。 */
    readonly stub?: StubPort;
  } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  stub: StubPort;
  fileSystem: MemoryFileSystem;
}> {
  const out = captured();
  const stub = options.stub ?? stubPort(options);
  const fileSystem = options.fileSystem ?? fileSystemWithSource();
  const exitCode = await runOcrCommand({ stdout: out.stdout, stderr: out.stderr }, commandInput, {
    createRuntime: () => ({ port: stub.port, fileSystem }),
  });
  return {
    exitCode,
    stdout: out.stdout.output(),
    stderr: out.stderr.output(),
    stub,
    fileSystem,
  };
}

/** 解析 stdout 的信封。 */
function envelopeOf(stdout: string): {
  version: number;
  key: string;
  ok: boolean;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  metrics?: { durationMs?: number; warnings?: string[]; degradedFrom?: string };
} {
  return JSON.parse(stdout) as never;
}

test("--help 输出用法且退出码为 0", async () => {
  const result = await runOcr(input([], {}, { help: true }));

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /zcode ocr/);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /parse/);
  assert.match(result.stdout, /models download/);
});

test("缺少命令与未知命令都退出码 1，错误写 stderr", async () => {
  const missing = await runOcr(input([]));
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /缺少命令/);

  const unknown = await runOcr(input(["explode"]));
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /未知命令/);
});

test("组合校验：子命令不接受不属于它的旗标", async () => {
  // ⚠️ 旗标**存在性**由全局严格解析器负责；本组只管"谁收哪些旗标"。
  const doctor = await runOcr(input(["doctor"], { path: "/tmp/a.pdf" }));
  assert.equal(doctor.exitCode, 1);
  assert.match(doctor.stderr, /doctor 不接受旗标/);

  const parse = await runOcr(input(["parse"], { path: "/tmp/a.pdf", source: "auto" }));
  assert.equal(parse.exitCode, 1);
  assert.match(parse.stderr, /parse 不接受旗标/);

  const models = await runOcr(input(["models", "download"], { tier: "basic", path: "/tmp/a.pdf" }));
  assert.equal(models.exitCode, 1);
  assert.match(models.stderr, /models download 不接受旗标/);
});

test("组合校验：parse 必填 --path，models download 必填 --tier", async () => {
  const parse = await runOcr(input(["parse"]));
  assert.equal(parse.exitCode, 1);
  assert.match(parse.stderr, /parse 需要 --path/);

  const models = await runOcr(input(["models", "download"]));
  assert.equal(models.exitCode, 1);
  assert.match(models.stderr, /models download 需要 --tier/);
});

test("A4: 档位原样透传给端口，CLI 不做预校验", async () => {
  // CLI 预校验会让「非法档位」的内部码出不来（端口才判定 engine_not_found），
  // 所以这里断言 CLI 把 `turbo` 原样递下去。
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH, tier: "turbo" }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.stub.parseCalls[0]?.tier, "turbo" as never);
});

test("A4: 端口报 engine_not_found 时对外归一为 invalid_input 且带 engineCode", async () => {
  const result = await runOcr(
    input(["parse"], { path: SOURCE_PATH, tier: "turbo" }, { json: true }),
    {
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
    },
  );

  assert.equal(result.exitCode, 1);
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.key, "ocr.parse");
  assert.equal(payload.error?.code, "invalid_input");
  assert.equal(payload.error?.details?.engineCode, "engine_not_found");
});

test("A5: 产物缺失归一为 internal + engineCode=artifact_missing，退出码 1", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
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
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.error?.code, "internal");
  assert.equal(payload.error?.details?.engineCode, "artifact_missing");
});

test("A6: 引擎失败归一为 internal + engineCode=process_failed，退出码 1", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
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
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.error?.code, "internal");
  assert.equal(payload.error?.hint, "CUDA out of memory");
});

test("加密 PDF 归一为 invalid_input + engineCode=password_protected，hint 指向 --pdf-password", async () => {
  // ⚠️ spec：ocr-local.md §3.2.1 —— 加密 PDF 是**输入前提不满足**，不是引擎故障。
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
    parse: {
      ok: false,
      error: {
        code: "password_protected",
        message: "PDF 已加密，需要密码才能解析",
        hint: "加密 PDF 需要密码：用 --pdf-password <密码> 重试",
        details: { engineCode: "password_protected", reason: "password_required" },
      },
      warnings: [],
      durationMs: 1,
    },
  });

  assert.equal(result.exitCode, 1);
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.error?.code, "invalid_input");
  assert.equal(payload.error?.details?.engineCode, "password_protected");
  assert.match(String(payload.error?.hint), /--pdf-password/u);
});

test("超时退出码是 124", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
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
  assert.equal(envelopeOf(result.stdout).error?.code, "timeout");
});

test("文件不存在时直接返回 not_found，不调引擎", async () => {
  const result = await runOcr(input(["parse"], { path: "/tmp/missing.pdf" }, { json: true }));

  assert.equal(result.exitCode, 1);
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.code, "not_found");
  assert.equal(result.stub.parseCalls.length, 0);
});

test("端口报的输入问题也归一为 not_found", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
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
  assert.equal(envelopeOf(result.stdout).error?.code, "not_found");
});

test("A10: --json 时 stdout 是单个 JSON 对象，引擎输出只在 stderr", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
    parse: {
      ...successfulParseResult(),
      stdout: "已解析 1 个输入。\n",
    },
  });

  assert.equal(result.exitCode, 0);
  // stdout 是**单个** JSON 对象：整段能解析成一个对象，且对象里没有混入引擎文本。
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.version, 1);
  assert.equal(payload.key, "ocr.parse");
  assert.equal(payload.output?.tier, "basic");
  assert.ok(!result.stdout.includes("已解析 1 个输入。"), "引擎输出不得混进 stdout");
  // 进度信息走 stderr。
  assert.match(result.stderr, /已解析 1 个输入。/);
});

test("A10: --json 时 stderr 是纯 NDJSON 进度流（每行一个事件）", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }));

  assert.equal(result.exitCode, 0);
  const lines = result.stderr.split("\n").filter((line) => line.trim() !== "");
  assert.ok(lines.length > 0, "必须有进度事件");
  for (const line of lines) {
    const event = JSON.parse(line) as { type?: string; phase?: string; percent?: unknown };
    assert.equal(event.type, "progress");
    assert.ok(["provision", "analyze", "write"].includes(event.phase ?? ""));
    assert.ok(event.percent === null || typeof event.percent === "number");
  }
  // ⚠️ 错误不进 stderr（JSON 模式）——stderr 只有进度行。
  assert.ok(!result.stderr.includes("失败"));
});

test("A10: 非 JSON 模式输出人读报告，引擎输出仍然只在 stderr", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }), {
    parse: {
      ...successfulParseResult(),
      stdout: "已解析 1 个输入。\n",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /解析成功/);
  assert.match(result.stdout, /report\.md/);
  assert.ok(!result.stdout.includes("已解析 1 个输入。"));
  assert.match(result.stderr, /已解析 1 个输入。/);
});

test("sidecar 写在源文件旁，路径全是相对路径", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }));

  assert.equal(result.exitCode, 0);
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.output?.sidecarPath, SIDECAR_PATH);
  // artifactsDir 相对 sidecar 所在目录；产物路径相对 artifactsDir。
  assert.equal(payload.output?.artifactsDir, "report.pdf.mineru");
  assert.equal(payload.output?.cached, false);

  const written = result.fileSystem.writes.find((write) => write.path === SIDECAR_PATH);
  assert.ok(written, "必须写 sidecar");
  assert.equal(written.atomic, true, "sidecar 必须是原子写");

  const sidecar = JSON.parse(written.content) as {
    version: number;
    artifactsDir: string;
    text?: { markdownPath?: string };
    pages: { composition: string | null; elements: { category: string; text?: string }[] }[];
  };
  assert.equal(sidecar.version, 3);
  assert.equal(sidecar.artifactsDir, "report.pdf.mineru");
  assert.equal(sidecar.text?.markdownPath, "report.md");
  assert.equal(sidecar.pages[0]?.composition, "text+image");
  // 文本类元素恒带文字；图片类不带。
  assert.equal(sidecar.pages[0]?.elements[0]?.text, "第一段");
  assert.equal(sidecar.pages[0]?.elements[1]?.text, undefined);
});

test("sidecar 命中时不重跑引擎（接力）", async () => {
  const fileSystem = fileSystemWithSource();
  const stub = stubPort({});

  const first = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
    fileSystem,
    stub,
  });
  assert.equal(first.exitCode, 0);
  assert.equal(stub.parseCalls.length, 1);

  const second = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
    fileSystem,
    stub,
  });
  assert.equal(second.exitCode, 0);
  assert.equal(stub.parseCalls.length, 1, "命中缓存时不得再调引擎");
  const payload = envelopeOf(second.stdout);
  assert.equal(payload.output?.cached, true);
  assert.equal(payload.output?.sidecarPath, SIDECAR_PATH);
  // ⚠️ 没给 --tier 时命中任意档位，但业务要看得见实际用的是哪一档。
  assert.equal(payload.output?.tier, "basic");
  assert.ok(payload.metrics?.warnings?.some((warning) => warning.includes("档位 basic")));
});

test("inspect 的输出只有页成分与元素位置，**没有文字正文**", async () => {
  const result = await runOcr(input(["inspect"], { path: SOURCE_PATH }, { json: true }));

  assert.equal(result.exitCode, 0);
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.key, "ocr.inspect");
  assert.equal(payload.output?.cached, false);
  assert.equal(payload.output?.sidecarPath, SIDECAR_PATH);
  assert.equal(payload.output?.artifactsDir, "report.pdf.mineru");

  const pages = payload.output?.pages as {
    pageIndex: number;
    composition: string | null;
    elements: Record<string, unknown>[];
  }[];
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.composition, "text+image");
  // ⚠️ **元素不带 `text`**（spec §5.8）—— 这是 inspect 与 parse 的唯一区别。
  assert.equal("text" in (pages[0]?.elements[0] ?? {}), false);
  assert.equal(pages[0]?.elements[0]?.category, "text");
  assert.equal(pages[0]?.elements[1]?.category, "image");
  assert.equal(pages[0]?.elements[1]?.imagePath, "images/p0.jpg");
  // ⚠️ inspect **不产出 markdown**（没有 artifacts 字段）。
  assert.equal(payload.output?.artifacts, undefined);
});

test("inspect 的 sidecar 里仍然带逐元素文字（parse 接力的前提）", async () => {
  const result = await runOcr(input(["inspect"], { path: SOURCE_PATH }, { json: true }));

  const written = result.fileSystem.writes.find((write) => write.path === SIDECAR_PATH);
  assert.ok(written, "必须写 sidecar");
  const sidecar = JSON.parse(written.content) as {
    text?: { markdownPath?: string };
    pages: { elements: { category: string; text?: string }[] }[];
  };
  assert.equal(sidecar.pages[0]?.elements[0]?.text, "第一段");
  // ⚠️ inspect 不产出 markdown ⇒ sidecar 里没有 text 段。
  assert.equal(sidecar.text, undefined);
});

test("组合校验：inspect 需要 --path，且不接受 --tier", async () => {
  const missing = await runOcr(input(["inspect"]));
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /inspect 需要 --path/);

  // ⚠️ **inspect 没有 --tier**（spec §4.2）：档位是识别路线的概念。
  const tiered = await runOcr(input(["inspect"], { path: SOURCE_PATH, tier: "basic" }));
  assert.equal(tiered.exitCode, 1);
  assert.match(tiered.stderr, /inspect 不接受旗标/);
});

test("接力：inspect 之后调 parse ⇒ 命中缓存，引擎不再被调用", async () => {
  const fileSystem = fileSystemWithSource();
  const stub = stubPort({});

  const first = await runOcr(input(["inspect"], { path: SOURCE_PATH }, { json: true }), {
    fileSystem,
    stub,
  });
  assert.equal(first.exitCode, 0);
  assert.equal(stub.parseCalls.length, 1);

  const second = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
    fileSystem,
    stub,
  });
  assert.equal(second.exitCode, 0);
  assert.equal(stub.parseCalls.length, 1, "接力时不得再调引擎");
  const payload = envelopeOf(second.stdout);
  assert.equal(payload.output?.cached, true);
  // ⚠️ **markdown 从 sidecar 的元素派生**（inspect 没产出过 markdown）。
  assert.equal((payload.output?.artifacts as Record<string, string>).markdownPath, "markdown.md");
});

test("接力：parse 之后调 inspect ⇒ 命中缓存", async () => {
  const fileSystem = fileSystemWithSource();
  const stub = stubPort({});

  await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), { fileSystem, stub });
  const second = await runOcr(input(["inspect"], { path: SOURCE_PATH }, { json: true }), {
    fileSystem,
    stub,
  });

  assert.equal(second.exitCode, 0);
  assert.equal(stub.parseCalls.length, 1, "接力时不得再调引擎");
  assert.equal(envelopeOf(second.stdout).output?.cached, true);
});

test("原生分析路线：引擎名是 pdf-native、档位是 native，markdown 由元素派生", async () => {
  const result = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
    parse: nativeParseResult(),
  });

  assert.equal(result.exitCode, 0);
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.output?.engine, "pdf-native");
  assert.equal(payload.output?.tier, "native");
  assert.equal((payload.output?.artifacts as Record<string, string>).markdownPath, "markdown.md");

  // ⚠️ 派生的 markdown 落进产物目录，并回填进 sidecar。
  const markdown = result.fileSystem.writes.find((write) =>
    write.path.endsWith("/report.pdf.mineru/markdown.md"),
  );
  assert.ok(markdown, "必须派生 markdown");
  assert.match(markdown.content, /本地 OCR 路线验证/);
  const sidecarWrite = result.fileSystem.writes.find((write) => write.path === SIDECAR_PATH);
  const sidecar = JSON.parse(sidecarWrite!.content) as {
    engine: { name: string; tier: string; route: string };
    text?: { markdownPath?: string };
  };
  assert.equal(sidecar.engine.name, "pdf-native");
  assert.equal(sidecar.engine.tier, "native");
  assert.equal(sidecar.engine.route, "pdf-native");
  assert.equal(sidecar.text?.markdownPath, "markdown.md");
});

test("原生分析路线：inspect 的输出里引擎名与档位也是原生分析的值", async () => {
  const result = await runOcr(input(["inspect"], { path: SOURCE_PATH }, { json: true }), {
    parse: nativeParseResult(),
  });

  assert.equal(result.exitCode, 0);
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.output?.engine, "pdf-native");
  assert.equal(payload.output?.tier, "native");
});

test("原生分析路线：请求给了 --tier 也照样命中缓存（档位判据不适用）", async () => {
  const fileSystem = fileSystemWithSource();
  const stub = stubPort({ parse: nativeParseResult() });

  await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), { fileSystem, stub });
  const second = await runOcr(
    input(["parse"], { path: SOURCE_PATH, tier: "basic" }, { json: true }),
    { fileSystem, stub },
  );

  assert.equal(second.exitCode, 0);
  assert.equal(stub.parseCalls.length, 1, "原生路线不该因为档位不符而重算");
  assert.equal(envelopeOf(second.stdout).output?.cached, true);
});

test("源文件内容变了 ⇒ 缓存失效，重新解析", async () => {
  const fileSystem = fileSystemWithSource();
  const stub = stubPort({});

  await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), { fileSystem, stub });
  // ⚠️ 内容变了但 **mtime 不变** ⇒ 只能靠内容指纹判出来。
  fileSystem.files.set(SOURCE_PATH, "PDF-CONTENT-CHANGED");

  const second = await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), {
    fileSystem,
    stub,
  });
  assert.equal(stub.parseCalls.length, 2);
  assert.equal(envelopeOf(second.stdout).output?.cached, false);
});

test("档位不一致 ⇒ 缓存失效", async () => {
  const fileSystem = fileSystemWithSource();
  const stub = stubPort({});

  await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), { fileSystem, stub });
  const second = await runOcr(
    input(["parse"], { path: SOURCE_PATH, tier: "standard" }, { json: true }),
    { fileSystem, stub },
  );
  assert.equal(stub.parseCalls.length, 2);
  assert.equal(envelopeOf(second.stdout).output?.cached, false);
});

test("--force 忽略缓存，强制重算", async () => {
  const fileSystem = fileSystemWithSource();
  const stub = stubPort({});

  await runOcr(input(["parse"], { path: SOURCE_PATH }, { json: true }), { fileSystem, stub });
  const second = await runOcr(
    input(["parse"], { path: SOURCE_PATH, force: true }, { json: true }),
    { fileSystem, stub },
  );
  assert.equal(stub.parseCalls.length, 2, "--force 必须重跑引擎");
  assert.equal(envelopeOf(second.stdout).output?.cached, false);
});

test("解析时向端口要元素级模型，密码只经请求传递", async () => {
  const result = await runOcr(
    input(["parse"], { path: SOURCE_PATH, pdfPassword: "s3cret" }, { json: true }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stub.parseCalls[0]?.documentModel, true);
  assert.equal(result.stub.parseCalls[0]?.password, "s3cret");
  // ⚠️ 密码不得出现在任何输出里。
  assert.ok(!result.stdout.includes("s3cret"));
  assert.ok(!result.stderr.includes("s3cret"));
});

test("doctor --json 是成功信封，报告在 output.report，退出码恒为 0", async () => {
  const result = await runOcr(input(["doctor"], {}, { json: true }));

  assert.equal(result.exitCode, 0);
  const payload = envelopeOf(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.key, "ocr.doctor");
  const report = payload.output?.report as {
    engines: { available: boolean; reason?: string; fix?: string }[];
    weightsFetched: boolean;
  };
  assert.equal(report.engines.length, 1);
  assert.equal(report.engines[0]?.available, false);
  assert.ok(report.engines[0]?.reason);
  assert.ok(report.engines[0]?.fix);
  assert.equal(report.weightsFetched, false);
});

test("doctor 人读模式写明「本地解析引擎体检」", async () => {
  const result = await runOcr(input(["doctor"]));

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /本地解析引擎体检/);
  assert.match(result.stdout, /本次体检未下载任何权重。/);
});

test("models download 只接受 basic / standard，其它档位退出码 1", async () => {
  const rejected = await runOcr(
    input(["models", "download"], { tier: "advanced" }, { json: true }),
  );
  assert.equal(rejected.exitCode, 1);
  const payload = envelopeOf(rejected.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.key, "ocr.models.download");
  assert.equal(payload.error?.code, "invalid_input");
  assert.equal(payload.error?.details?.engineCode, "engine_not_found");
  assert.equal(rejected.stub.downloadCalls.length, 0);

  const accepted = await runOcr(input(["models", "download"], { tier: "basic" }));
  assert.equal(accepted.exitCode, 0);
  assert.equal(accepted.stub.downloadCalls[0]?.tier, "basic");
});

test("models download 的引擎输出只走 stderr，不混进 stdout 的 JSON", async () => {
  const result = await runOcr(input(["models", "download"], { tier: "basic" }, { json: true }), {
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
  assert.ok(!result.stdout.includes("已下载 1 个仓库。"));
  assert.match(result.stderr, /已下载 1 个仓库。/);
});

// ---------------------------------------------------------------------------
// 接线：`zcode` 主入口 → 全局解析器 → `zcode ocr` 子命令组
// ---------------------------------------------------------------------------

type CapturedWriteStream = NodeJS.WriteStream & { output(): string };

function cliStream(): CapturedWriteStream {
  let output = "";
  return {
    output: () => output,
    write(chunk: string | Uint8Array): boolean {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    },
  } as CapturedWriteStream;
}

function cliContext(argv: string[]): RunContext & {
  stdout: CapturedWriteStream;
  stderr: CapturedWriteStream;
} {
  return {
    argv,
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: cliStream(),
    stderr: cliStream(),
  };
}

test("接线：`zcode ocr --help` 打印本组用法，不是全局帮助", async () => {
  const ctx = cliContext(["ocr", "--help"]);

  const code = await runCli(ctx, { cwd: () => process.cwd() });

  assert.equal(code, 0);
  assert.match(ctx.stdout.output(), /zcode ocr ——/);
  assert.match(ctx.stdout.output(), /models download/);
  // 不得打印全局帮助（全局帮助里有 "app-server" 这类别的命令清单）。
  assert.doesNotMatch(ctx.stdout.output(), /app-server/);
});

test("接线：`zcode ocr` 缺子命令时退出码 1 并给出用法", async () => {
  const ctx = cliContext(["ocr"]);

  const code = await runCli(ctx, { cwd: () => process.cwd() });

  assert.equal(code, 1);
  assert.match(ctx.stderr.output(), /缺少命令/);
  assert.match(ctx.stderr.output(), /zcode ocr/);
});

test("接线：全局帮助的命令清单里有 ocr", async () => {
  const ctx = cliContext(["--help"]);

  const code = await runCli(ctx, { cwd: () => process.cwd() });

  assert.equal(code, 0);
  assert.match(ctx.stdout.output(), /^\s+ocr\s/m);
});
