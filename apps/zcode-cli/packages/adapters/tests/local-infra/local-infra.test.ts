import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PdfDocumentPortError } from "@zcode/contracts";
import type {
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  PdfDocumentPort,
} from "@zcode/contracts";
import { createLocalInfraPort, MODELS_DOWNLOAD_TIMEOUT_MS } from "../../src/local-infra/index.js";
import { createNodeFileSystemAdapter } from "../../src/fs/index.js";
import {
  argvOf,
  buildZip,
  completedResult,
  createFakeEngine,
  failedResult,
  fakeExecutionPort,
  hardwareDetectJson,
  mineruArtifacts,
  modelsShowText,
  timedOutResult,
} from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 假引擎的默认行为：硬件探测 + 型号查询 + 版本查询 + 解析产出 zip。 */
interface EngineOptions {
  readonly hardware?: string;
  readonly parseEntries?: () => Promise<
    { entries: ReturnType<typeof mineruArtifacts> } | undefined
  >;
  readonly parseExit?: { readonly code: number; readonly stderr: string };
  readonly parseTimedOut?: boolean;
  /** 解析时产出的 zip 条目（用于产物形状与恶意条目用例）。 */
  readonly parseZip?: () => Buffer | undefined;
}

function engineHandler(options: EngineOptions = {}) {
  return async (request: ExecutionRequest): Promise<ExecutionResult> => {
    const args = argvOf(request);
    if (args[0] === "hardware" && args[1] === "detect") {
      return completedResult({ stdout: options.hardware ?? hardwareDetectJson({}) });
    }
    if (args[0] === "models" && args[1] === "show") {
      return completedResult({ stdout: modelsShowText() });
    }
    if (args[0] === "version") {
      return completedResult({ stdout: JSON.stringify({ mineru_version: "4.1.7" }) });
    }
    if (args[0] === "--version") {
      return completedResult({ stdout: "MinerU 版本: 4.1.7\n" });
    }
    if (args[0] === "models" && args[1] === "download") {
      return completedResult({ stdout: "已下载 3 个仓库。\n" });
    }
    // 解析调用：`mineru-kit parse <input> ... --format zip --output <archive>`
    const outputIndex = args.indexOf("--output");
    const archivePath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
    if (archivePath !== undefined) {
      // ⚠️ **假引擎要像真引擎一样挑形状**：真引擎的 `parse` 是子命令，
      // 漏掉它时会把输入路径当未知子命令、报 `No such command '<path>'`（退出码 2）。
      // 假引擎若照单全收，这类回归就只能等真实环境才能发现。
      if (args[0] !== "parse") {
        return failedResult(`No such command '${args[0]}'.`, 2);
      }
      if (options.parseTimedOut === true) return timedOutResult();
      if (options.parseExit !== undefined) {
        return failedResult(options.parseExit.stderr, options.parseExit.code);
      }
      const zip = options.parseZip?.();
      if (zip !== undefined) await writeFile(archivePath, zip);
      return completedResult({ stdout: "已解析 1 个输入。\n" });
    }
    return completedResult();
  };
}

/**
 * 假 PDF 端口（poppler 那一侧）。
 *
 * ⚠️ **加密语义要像真的**：poppler 的 `pdfinfo` 对加密 PDF 是「退出码非 0 + stderr 说密码错」，
 * 端口层把它归成 `password_protected` 抛出 —— 端口实现见 `src/pdf/index.ts`。
 */
interface FakePdfOptions {
  readonly pageCount?: number | undefined;
  /** 不带密码探时报密码错 ⇒ 这份 PDF 是加密的。 */
  readonly encrypted?: boolean;
  /** 带密码探时也报密码错 ⇒ 密码不对。 */
  readonly rejectPassword?: boolean;
}

function fakePdf(options: FakePdfOptions = {}): PdfDocumentPort {
  const pageCount = options.pageCount ?? 12;
  return {
    async getPageCount(request: { password?: string }) {
      if (options.encrypted === true && request.password === undefined) {
        throw new PdfDocumentPortError("password_protected", "PDF is password-protected.");
      }
      if (options.rejectPassword === true && request.password !== undefined) {
        throw new PdfDocumentPortError("password_protected", "PDF password was rejected.");
      }
      return pageCount;
    },
    async decryptToFile(request: { outputPath: string }) {
      // ⚠️ 真的落一份文件：后面要断言「用完即删」。
      await writeFile(request.outputPath, "%PDF-1.7\n% decrypted\n");
      return { path: request.outputPath, bytes: 22 };
    },
  } as unknown as PdfDocumentPort;
}

interface Harness {
  readonly port: ReturnType<typeof createLocalInfraPort>;
  readonly execution: ExecutionPort & { calls: ExecutionRequest[] };
  readonly kitPath: string;
  readonly root: string;
}

async function createHarness(
  options: EngineOptions & {
    readonly pages?: number | undefined;
    readonly pdf?: FakePdfOptions;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
  roots.push(root);
  const kitPath = await createFakeEngine(root);
  const execution = fakeExecutionPort(engineHandler(options));
  const port = createLocalInfraPort({
    execution,
    fileSystem: createNodeFileSystemAdapter(),
    config: { mineruPath: kitPath },
    pdf: fakePdf({ pageCount: options.pages, ...options.pdf }),
  });
  return { port, execution, kitPath, root };
}

describe("本地基础设施端口 —— doctor", () => {
  it("A1: 引擎不可用时报告可用性、原因与装法，且不发生任何下载", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
    roots.push(root);
    const execution = fakeExecutionPort(async () => completedResult());
    const port = createLocalInfraPort({
      execution,
      fileSystem: createNodeFileSystemAdapter(),
      config: { mineruPath: join(root, "missing", "mineru-kit") },
    });

    const report = await port.doctor();

    expect(report.engines).toHaveLength(1);
    expect(report.engines[0]).toMatchObject({
      engine: "mineru",
      available: false,
      versionToolAvailable: false,
    });
    expect(report.engines[0]!.reason).toBeTruthy();
    expect(report.engines[0]!.fix).toContain("uv tool install");
    expect(report.weightsFetched).toBe(false);
    // doctor 是只读命令：没有引擎时连一次 spawn 都不该有。
    expect(execution.calls).toHaveLength(0);
  });

  it("A2: 只配了 ocr.mineruPath（不在 PATH）时仍能找到并报为可用", async () => {
    const harness = await createHarness();

    const report = await harness.port.doctor();

    expect(report.engines[0]).toMatchObject({
      available: true,
      path: harness.kitPath,
      versionToolAvailable: true,
      version: "4.1.7",
    });
    expect(report.supportedTiers).toEqual(["flash", "basic", "standard", "advanced"]);
    expect(report.weightsFetched).toBe(false);
  });

  it("doctor 不下载权重，也不改代理环境", async () => {
    const harness = await createHarness();

    await harness.port.doctor();

    for (const call of harness.execution.calls) {
      expect(call.env?.unset ?? []).toEqual([]);
    }
  });
});

describe("本地基础设施端口 —— parse", () => {
  it("A3: 请求的档位本机不支持时降级到 ceiling 并告知原因", async () => {
    const harness = await createHarness({
      hardware: hardwareDetectJson({
        ceiling: "standard",
        pdfImageTiers: ["flash", "basic", "standard"],
        defaultRequestTier: "basic",
      }),
      parseZip: () => buildZip(mineruArtifacts("standard")),
    });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input, tier: "advanced" });

    expect(result.ok).toBe(true);
    expect(result.degradedFrom).toBe("advanced");
    expect(result.tier).toBe("standard");
    expect(result.warnings.join("\n")).toContain("advanced");
    expect(result.warnings.join("\n")).toContain("产物形状可能与请求档位不同");
    // 降级后只执行一次，不换档重跑。
    expect(
      harness.execution.calls.filter((call) => argvOf(call).includes("--format")),
    ).toHaveLength(1);
  });

  it("A4: 档位不在官方枚举内时报错，且不 spawn 任何子进程", async () => {
    const harness = await createHarness();
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({
      path: input,
      // 端口契约声明的是枚举，调用方（CLI）透传的是原始字符串 —— 运行期仍要挡住。
      tier: "turbo" as never,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("engine_not_found");
    expect(result.error?.details?.engineCode).toBe("engine_not_found");
    expect(harness.execution.calls).toHaveLength(0);
  });

  it("A5: 引擎退出码 0 但没有产物时报 artifact_missing，不得当成功", async () => {
    const harness = await createHarness({ parseZip: () => undefined });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("artifact_missing");
    expect(result.error?.details?.engineCode).toBe("artifact_missing");
  });

  it("A6: 引擎非零退出时报 process_failed，且不自动换档重跑", async () => {
    const harness = await createHarness({
      parseExit: { code: 3, stderr: "CUDA out of memory" },
    });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("process_failed");
    expect(result.error?.hint).toContain("CUDA out of memory");
    expect(
      harness.execution.calls.filter((call) => argvOf(call).includes("--format")),
    ).toHaveLength(1);
  });

  it("A7: 多页 PDF 传 --pages all，产物是一份整文档产物", async () => {
    const harness = await createHarness({ parseZip: () => buildZip(mineruArtifacts("basic")) });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input });

    expect(result.ok).toBe(true);
    const parseCall = harness.execution.calls.find((call) => argvOf(call).includes("--format"));
    expect(argvOf(parseCall!)).toEqual(expect.arrayContaining(["--pages", "all"]));
    expect(result.output?.markdownPath).toBeTruthy();
    expect(result.output?.structuredContentPath).toBeTruthy();
    expect(result.output?.middleJsonPath).toBeTruthy();
  });

  it("A8: 图片输入不传 --pages", async () => {
    const harness = await createHarness({ parseZip: () => buildZip(mineruArtifacts("basic")) });
    const input = join(harness.root, "scan.png");
    await writeFile(input, "png-bytes");

    const result = await harness.port.parse({ path: input });

    expect(result.ok).toBe(true);
    const parseCall = harness.execution.calls.find((call) => argvOf(call).includes("--format"));
    expect(argvOf(parseCall!)).not.toContain("--pages");
  });

  it("A11: 解析子进程不剥离代理变量（解析是纯本地推理）", async () => {
    const harness = await createHarness({ parseZip: () => buildZip(mineruArtifacts("basic")) });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    await harness.port.parse({ path: input });

    const parseCall = harness.execution.calls.find((call) => argvOf(call).includes("--format"));
    expect(parseCall?.env?.unset ?? []).toEqual([]);
  });

  it("A12: 产物文件名随版本变化时按内容分类", async () => {
    const harness = await createHarness({
      parseZip: () =>
        buildZip([
          { name: "markdown.md", content: "# 正文\n" },
          {
            name: "content_2026.json",
            content: JSON.stringify({
              pages: [{ page_idx: 0, blocks: [] }],
              extensions: { mineru: { tier: "basic" } },
            }),
          },
          {
            name: "intermediate.json",
            content: JSON.stringify({
              schema: "docvortex.middle",
              schema_version: "1",
              pages: [{ page_idx: 0, blocks: [] }],
              extensions: { mineru: { tier: "basic" } },
            }),
          },
        ]),
    });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input });

    expect(result.ok).toBe(true);
    expect(result.output?.structuredContentPath).toContain("content_2026.json");
    expect(result.output?.middleJsonPath).toContain("intermediate.json");
    expect(result.tier).toBe("basic");
  });

  it("A13: 一次调用只 spawn 一次 parse（三件套一次取全）", async () => {
    const harness = await createHarness({ parseZip: () => buildZip(mineruArtifacts("basic")) });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    await harness.port.parse({ path: input });

    expect(
      harness.execution.calls.filter((call) => argvOf(call).includes("--format")),
    ).toHaveLength(1);
  });

  it("调用的 argv 以 parse 子命令开头", async () => {
    // ⚠️ 回归：`mineru-kit parse <inputs>...` 是**子命令**。漏掉 `parse` 时
    // 引擎把输入路径当未知子命令，报 `No such command '/path/to.pdf'`（退出码 2）。
    const harness = await createHarness({ parseZip: () => buildZip(mineruArtifacts("basic")) });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    await harness.port.parse({ path: input });

    const parseCall = harness.execution.calls.find((call) => argvOf(call).includes("--format"));
    expect(argvOf(parseCall!)[0]).toBe("parse");
    expect(argvOf(parseCall!)[1]).toBe(input);
  });

  it("红线：体检与解析的 argv 里绝不出现远程参数，也不注入凭据环境变量", async () => {
    // ⚠️ **产品红线**（local-infra §6）：ZCode 绝不构造 `--remote` / `--remote-url` /
    // `--api-key` —— 远程解析会把文档送出本机。这条断言盯住两条路：
    // **远程开关在 argv 上，凭据在 env.set 上**。体检与解析都过一遍。
    const harness = await createHarness({ parseZip: () => buildZip(mineruArtifacts("basic")) });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    await harness.port.doctor();
    await harness.port.parse({ path: input });

    expect(harness.execution.calls.length).toBeGreaterThan(0);
    for (const call of harness.execution.calls) {
      const args = argvOf(call);
      for (const forbidden of ["--remote", "--remote-url", "--api-key"]) {
        expect(args).not.toContain(forbidden);
      }
      // 也不能用 `--api-key=<值>` 这类写法把凭据塞进 argv。
      expect(args.some((arg) => /(api[-_]?key|token|secret)[=/]/iu.test(arg))).toBe(false);
      // 环境只允许「剥离代理变量」，不允许注入任何变量（凭据也不例外）。
      expect(call.env?.set).toBeUndefined();
    }
  });

  it("A10: 引擎 stdout 原样透出，供命令面当进度信息写 stderr", async () => {
    const harness = await createHarness({ parseZip: () => buildZip(mineruArtifacts("basic")) });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input });

    // ⚠️ 引擎 stdout 是人读文本，**不是 JSON** —— 消费方不得当 JSON 解析（验收 A10）。
    expect(result.stdout).toContain("已解析 1 个输入。");
  });

  it("A14: 临时 zip 路径必须带 .zip 后缀", async () => {
    const harness = await createHarness({ parseZip: () => buildZip(mineruArtifacts("basic")) });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    await harness.port.parse({ path: input });

    const parseCall = harness.execution.calls.find((call) => argvOf(call).includes("--format"));
    const args = argvOf(parseCall!);
    const archivePath = args[args.indexOf("--output") + 1]!;
    expect(archivePath.endsWith(".zip")).toBe(true);
  });

  it("A15: zip 里的恶意条目名被拒绝，不写到目标目录之外", async () => {
    const harness = await createHarness({
      parseZip: () =>
        buildZip([
          { name: "markdown.md", content: "# 正文\n" },
          { name: "../escaped.md", content: "越界内容" },
        ]),
    });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");
    const outputDir = join(harness.root, "out");

    const result = await harness.port.parse({ path: input, outputDir });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("process_failed");
    await expect(readFile(join(harness.root, "escaped.md"), "utf8")).rejects.toThrow();
  });

  it("输入文件不存在时报 input_invalid（对外归一为 not_found）", async () => {
    const harness = await createHarness();

    const result = await harness.port.parse({ path: join(harness.root, "missing.pdf") });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("input_invalid");
    expect(result.error?.details?.reason).toBe("not_found");
  });

  it("不支持的文件类型报 input_invalid（对外归一为 unsupported_input）", async () => {
    const harness = await createHarness();
    const input = join(harness.root, "notes.docx");
    await writeFile(input, "docx");

    const result = await harness.port.parse({ path: input });

    expect(result.ok).toBe(false);
    expect(result.error?.details?.reason).toBe("unsupported_input");
  });

  it("图片与 markdown 放在同一棵目录里，markdown 里的相对图片链接才不断", async () => {
    const harness = await createHarness({
      parseZip: () =>
        buildZip([
          { name: "markdown.md", content: "![图](images/a.jpg)\n" },
          { name: "images/a.jpg", content: "jpeg-bytes" },
          ...mineruArtifacts("basic"),
        ]),
    });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");
    const outputDir = join(harness.root, "out");

    const result = await harness.port.parse({ path: input, outputDir });

    expect(result.ok).toBe(true);
    expect(result.output?.markdownPath).toBe(join(outputDir, "markdown.md"));
    // assetsDir 落在 markdown 所在目录之内（这里是它的子目录 images）。
    expect(result.output?.assetsDir).toBe(join(outputDir, "images"));
  });
});

describe("本地基础设施端口 —— models download", () => {
  it("A11: 下载子进程剥离全部代理变量名", async () => {
    const harness = await createHarness();

    await harness.port.downloadModels({ tier: "basic" });

    const downloadCall = harness.execution.calls.find(
      (call) => argvOf(call)[0] === "models" && argvOf(call)[1] === "download",
    );
    expect(downloadCall?.env?.unset).toEqual([
      "ALL_PROXY",
      "all_proxy",
      "http_proxy",
      "https_proxy",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "no_proxy",
    ]);
  });

  it("代理策略为 inherit 时不剥离代理变量", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
    roots.push(root);
    const kitPath = await createFakeEngine(root);
    const execution = fakeExecutionPort(engineHandler());
    const port = createLocalInfraPort({
      execution,
      fileSystem: createNodeFileSystemAdapter(),
      config: { mineruPath: kitPath, mineruProxy: "inherit" },
    });

    await port.downloadModels({ tier: "basic" });

    const downloadCall = execution.calls.find(
      (call) => argvOf(call)[0] === "models" && argvOf(call)[1] === "download",
    );
    expect(downloadCall?.env?.unset ?? []).toEqual([]);
  });

  it("下载请求把超时预算与取消信号透传给执行端口（第 2 步的自动路线）", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
    roots.push(root);
    const kitPath = await createFakeEngine(root);
    const controller = new AbortController();
    const seen: { timeoutMs?: number; signal?: AbortSignal }[] = [];
    const execution = {
      async run(request: ExecutionRequest, options?: { signal?: AbortSignal }) {
        seen.push({
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        });
        return completedResult({ stdout: "已下载 3 个仓库。\n" });
      },
    } as unknown as ExecutionPort;
    const port = createLocalInfraPort({
      execution,
      fileSystem: createNodeFileSystemAdapter(),
      config: { mineruPath: kitPath },
    });

    await port.downloadModels({ tier: "basic", timeoutMs: 1234, signal: controller.signal });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.timeoutMs).toBe(1234);
    // ⚠️ 取消必须透传：用户取消任务时，正在下载的权重要一起停。
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it("下载请求不给预算时沿用端口的默认上限", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
    roots.push(root);
    const kitPath = await createFakeEngine(root);
    const execution = fakeExecutionPort(engineHandler());
    const port = createLocalInfraPort({
      execution,
      fileSystem: createNodeFileSystemAdapter(),
      config: { mineruPath: kitPath },
    });

    await port.downloadModels({ tier: "basic" });

    const downloadCall = execution.calls.find(
      (call) => argvOf(call)[0] === "models" && argvOf(call)[1] === "download",
    );
    expect(downloadCall?.timeoutMs).toBe(MODELS_DOWNLOAD_TIMEOUT_MS);
  });
});

/**
 * 加密 PDF 的解密路线（spec：docs/design/v2/ocr-local.md §3.2.1）。
 *
 * ⚠️ 根因（MinerU 4.1.7 实测）：引擎**没有任何密码入口** —— 加密 PDF 直接喂进去
 * 必报 `Failed to load document (PDFium: Incorrect password error).`
 * ⇒ 密码由 ZCode 侧用 poppler 前置解密消费。
 */
describe("本地基础设施端口 —— 加密 PDF", () => {
  it("加密 PDF 没给密码：直接报 password_protected，不空跑一次引擎", async () => {
    const harness = await createHarness({ pdf: { encrypted: true } });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("password_protected");
    expect(result.error?.hint).toContain("--pdf-password");
    // ⚠️ 关键断言：**没有 spawn 过引擎的 parse** —— 加密 PDF 不该白跑一次几十秒的解析。
    expect(
      harness.execution.calls.filter((call) => argvOf(call).includes("--format")),
    ).toHaveLength(0);
  });

  it("加密 PDF 密码被拒：报 password_protected，不调引擎", async () => {
    const harness = await createHarness({ pdf: { encrypted: true, rejectPassword: true } });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input, password: "wrong" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("password_protected");
    expect(result.error?.details?.reason).toBe("password_rejected");
    expect(
      harness.execution.calls.filter((call) => argvOf(call).includes("--format")),
    ).toHaveLength(0);
  });

  it("加密 PDF 给了密码：引擎拿到的是解密副本，原文件不进 argv，副本用完即删", async () => {
    const harness = await createHarness({
      pdf: { encrypted: true },
      parseZip: () => buildZip(mineruArtifacts("basic")),
    });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input, password: "pw" });

    expect(result.ok).toBe(true);
    const parseCall = harness.execution.calls.find((call) => argvOf(call).includes("--format"))!;
    const args = argvOf(parseCall);
    const engineInput = args[1]!;
    // ⚠️ 引擎拿到的**不是原文件**（原文件是加密的，引擎打不开）。
    expect(engineInput).not.toBe(input);
    expect(engineInput.endsWith(".pdf")).toBe(true);
    // ⚠️ 密码**绝不出现在引擎的 argv 里** —— 引擎没有密码入口，密码只经 poppler 的 argv 走。
    expect(args).not.toContain("pw");
    // ⚠️ 解密副本是受保护文档的明文 ⇒ 用完即删。
    await expect(stat(engineInput)).rejects.toThrow();
  });

  it("引擎 stderr 里的 Incorrect password 归一成 password_protected（没接 poppler 时的兜底）", async () => {
    const harness = await createHarness({
      parseExit: {
        code: 1,
        stderr: "Failed to load document (PDFium: Incorrect password error).",
      },
    });
    const input = join(harness.root, "input.pdf");
    await writeFile(input, "%PDF-1.7");

    const result = await harness.port.parse({ path: input });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("password_protected");
    expect(result.error?.hint).toContain("--pdf-password");
  });
});
