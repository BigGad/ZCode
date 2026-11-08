import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { extname, join, resolve } from "node:path";
import { createTraceId, MINERU_TIERS } from "@zcode/contracts";
import type {
  EngineAvailability,
  LocalInfraDoctorReport,
  LocalInfraDeps,
  LocalInfraError,
  LocalInfraPort,
  LocalModelsDownloadRequest,
  LocalModelsDownloadResult,
  LocalParseRequest,
  LocalParseResult,
  MineruTier,
} from "@zcode/contracts";
import { extractZipArchive } from "../fs/zip-extract.js";
import { prepareOutputDir, scanArtifacts } from "./artifact-store.js";
import {
  HARDWARE_DETECT_TIMEOUT_MS,
  MINERU_INSTALL_HINT,
  MODELS_DOWNLOAD_TIMEOUT_MS,
  MODELS_SHOW_TIMEOUT_MS,
  PARSE_COLD_START_BUDGET_MS,
  TIER_SECONDS_PER_PAGE,
  VERSION_CHECK_TIMEOUT_MS,
} from "./constants.js";
import { locateMineruKit } from "./engine-locator.js";
import { parseJsonObject, runMineruCli } from "./mineru-cli.js";
import { parseModelsShow, toTierModelStatuses } from "./models-status.js";
import { decideTier, isMineruTier, parseHardwareDetect } from "./tier-selection.js";

export * from "./constants.js";
export * from "./engine-locator.js";
export * from "./models-status.js";
export * from "./tier-selection.js";

/** 支持的图片输入格式。 */
const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"];

/** 失败时贴给用户的 stderr 尾部长度。 */
const STDERR_TAIL_LIMIT = 2000;

/**
 * 本地基础设施端口实现（spec：docs/design/v2/local-infra.md §7.1）。
 *
 * ⚠️ **依赖由组合根注入**（`ExecutionPort` / `FileSystemPort`）——这里绝不 new 一个
 * ExecutionPort，否则会出现两个实例，代理策略与超时各走一套。
 */
export function createLocalInfraPort(deps: LocalInfraDeps): LocalInfraPort {
  return new LocalInfraAdapter(deps);
}

class LocalInfraAdapter implements LocalInfraPort {
  constructor(private readonly deps: LocalInfraDeps) {}

  /**
   * 环境体检（只读）。
   *
   * ⚠️ 退出码语义由 CLI 层决定：**体检报告本身就是结果**，"不可用"是有效报告而不是命令失败。
   * ⚠️ 本方法**不下载任何权重**，因此 `weightsFetched` 恒为 false。
   */
  async doctor(): Promise<LocalInfraDoctorReport> {
    const startedAt = Date.now();
    const located = await locateMineruKit({ configuredPath: this.deps.config?.mineruPath });

    if (located.engine === undefined) {
      return {
        engines: [
          {
            engine: "mineru",
            available: false,
            versionToolAvailable: false,
            reason: located.reason ?? "未找到 mineru-kit 可执行文件",
            fix: MINERU_INSTALL_HINT,
          },
        ],
        supportedTiers: [],
        models: [],
        weightsFetched: false,
        durationMs: Date.now() - startedAt,
      };
    }

    const kit = located.engine;
    const hardwareRun = await runMineruCli(
      {
        executable: kit.path,
        args: ["hardware", "detect", "--json"],
        timeoutMs: HARDWARE_DETECT_TIMEOUT_MS,
        // 体检是本地只读调用，不需要也不应该动代理。
        stripProxy: false,
      },
      this.deps.execution,
    );
    const hardware = hardwareRun.ok ? parseHardwareDetect(hardwareRun.stdout) : undefined;

    const modelsRun = await runMineruCli(
      {
        executable: kit.path,
        args: ["models", "show"],
        timeoutMs: MODELS_SHOW_TIMEOUT_MS,
        stripProxy: false,
      },
      this.deps.execution,
    );
    const models = modelsRun.ok ? toTierModelStatuses(parseModelsShow(modelsRun.stdout)) : [];

    const version = await this.readEngineVersion(kit.path, kit.versionToolPath);

    const engine: EngineAvailability = {
      engine: "mineru",
      available: true,
      path: kit.path,
      versionToolAvailable: kit.versionToolPath !== undefined,
      ...(kit.versionToolPath !== undefined ? { versionToolPath: kit.versionToolPath } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(hardware === undefined
        ? { reason: "hardware detect 未能解析出档位信息，档位由 MinerU 自选" }
        : {}),
    };

    return {
      engines: [engine],
      ...(hardware?.ceiling !== undefined ? { ceilingTier: hardware.ceiling } : {}),
      supportedTiers: hardware?.pdfImageTiers ?? [],
      ...(hardware?.defaultRequestTier !== undefined
        ? { defaultTier: hardware.defaultRequestTier }
        : {}),
      ...(hardware?.device !== undefined ? { device: hardware.device } : {}),
      ...(hardware?.calibration !== undefined ? { calibration: hardware.calibration } : {}),
      models,
      weightsFetched: false,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * 解析一份文档。
   *
   * ⚠️ **只 spawn 一次** `mineru-kit parse`（一次付冷启动），三件套一次取全。
   * ⚠️ **绝不构造 `--remote` / `--remote-url` / `--api-key`**：本地基础设施这个产品承诺
   * 不能被静默打破，远程解析会把文档送出本机。
   */
  async parse(request: LocalParseRequest): Promise<LocalParseResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];
    const inputPath = resolve(request.path);

    const inputError = await this.validateInput(inputPath);
    if (inputError !== undefined) {
      return this.failure(startedAt, inputError, warnings);
    }

    // ⚠️ 档位枚举校验必须在**任何 spawn 之前**（验收 A4：非法档位不 spawn 子进程）。
    // 端口的请求类型把档位声明成 `MineruTier`，但调用方（CLI）透传的是原始字符串，
    // 运行期仍可能是枚举外的值 —— 这里按运行期事实判定。
    if (request.tier !== undefined && !isMineruTier(request.tier)) {
      return this.failure(
        startedAt,
        {
          code: "engine_not_found",
          message: `未知的解析档位：${String(request.tier)}`,
          hint: `可用档位：${MINERU_TIERS.join("、")}`,
          details: { engineCode: "engine_not_found", tier: String(request.tier) },
        },
        warnings,
      );
    }

    const isPdf = extname(inputPath).toLowerCase() === ".pdf";

    const located = await locateMineruKit({ configuredPath: this.deps.config?.mineruPath });
    if (located.engine === undefined) {
      return this.failure(
        startedAt,
        {
          code: "engine_unavailable",
          message: located.reason ?? "未找到 mineru-kit 可执行文件",
          hint: `安装：${MINERU_INSTALL_HINT}`,
          details: {
            engineCode: "engine_unavailable",
            searched: located.searched,
          },
        },
        warnings,
      );
    }
    const kit = located.engine;

    const hardwareRun = await runMineruCli(
      {
        executable: kit.path,
        args: ["hardware", "detect", "--json"],
        timeoutMs: HARDWARE_DETECT_TIMEOUT_MS,
        stripProxy: false,
      },
      this.deps.execution,
    );
    const hardware = hardwareRun.ok ? parseHardwareDetect(hardwareRun.stdout) : undefined;
    if (hardware === undefined) {
      warnings.push("未能读取本机档位信息，档位交由 MinerU 自选");
    }

    const decision = decideTier({
      requested: request.tier,
      ...(hardware !== undefined ? { hardware } : {}),
      systemMemoryBytes: totalmem(),
    });
    if (decision.error !== undefined) {
      return this.failure(startedAt, decision.error, warnings);
    }
    warnings.push(...decision.warnings);
    const tier = decision.tier;

    const pageCount = await this.resolvePageCount(inputPath, isPdf);
    if (pageCount === undefined) {
      warnings.push("未能取到页数，超时预算按 1 页计费");
    }
    const budget = this.parseTimeoutMs(pageCount ?? 1, tier);

    const outputDir =
      request.outputDir !== undefined ? resolve(request.outputDir) : `${inputPath}.mineru`;

    // ⚠️ **临时 zip 必须带 `.zip` 后缀**（spec §5.5）：否则 MinerU 会创建同名目录、
    // 把产物写在里面 ⇒ 引擎退出码 0 但 ZCode 找不到 zip ⇒ 误报 artifact_missing。
    const archivePath = join(tmpdir(), `zcode-mineru-${randomUUID()}.zip`);

    // ⚠️ **`parse` 是子命令，必须放在最前面** —— `mineru-kit parse <inputs>...`
    // （实测 `mineru-kit parse --help`）。漏掉它时 MinerU 会把输入路径当成
    // 未知子命令，报 `No such command '/path/to.pdf'`（退出码 2）。
    const args = ["parse", inputPath];
    // ⚠️ `--pages` 只对 PDF 有效，图片输入带上会被引擎拒。
    if (isPdf) args.push("--pages", "all");
    if (tier !== undefined) args.push("--tier", tier);
    args.push("--format", "zip", "--output", archivePath);

    const run = await runMineruCli(
      {
        executable: kit.path,
        args,
        timeoutMs: budget,
        // ⚠️ 解析是**纯本地推理**，不联网；代理策略只作用于下载子进程（spec §7.9）。
        stripProxy: false,
      },
      this.deps.execution,
    );

    try {
      if (run.timedOut) {
        return this.failure(
          startedAt,
          {
            code: "timeout",
            message: `解析超时（${Math.round(budget / 1000)}s）`,
            hint: "可能是模型未加载起来，也可能是文档太大；可换更小的档位或拆分文档后重试",
            details: { engineCode: "timeout", timeoutMs: budget, pageCount: pageCount ?? 1 },
          },
          warnings,
        );
      }

      if (!run.ok) {
        return this.failure(
          startedAt,
          {
            code: "process_failed",
            message: `引擎执行失败（退出码 ${run.exitCode ?? "未知"}）`,
            hint: run.stderr.trim() === "" ? undefined : tailText(run.stderr, STDERR_TAIL_LIMIT),
            details: {
              engineCode: "process_failed",
              exitCode: run.exitCode,
              stderr: tailText(run.stderr, STDERR_TAIL_LIMIT),
            },
          },
          warnings,
        );
      }

      const archiveStat = await statFile(archivePath);
      if (archiveStat === undefined) {
        return this.failure(
          startedAt,
          {
            code: "artifact_missing",
            message: "引擎退出码为 0，但没有产出结果文件",
            hint: "可带 --verbose 重跑引擎确认产物去了哪里",
            details: { engineCode: "artifact_missing", archivePath },
          },
          warnings,
        );
      }

      // ⚠️ 解包前必须清空目标目录（spec §5.5）：否则升版后新旧产物共存会导致分类歧义。
      await prepareOutputDir(outputDir);
      await extractZipArchive({
        archivePath,
        targetRoot: outputDir,
        label: "MinerU parse output",
      });

      const scan = await scanArtifacts(outputDir);
      if (scan.markdownPath === undefined && scan.structuredContentPath === undefined) {
        return this.failure(
          startedAt,
          {
            code: "artifact_missing",
            message: "产物目录里没有可识别的解析结果",
            hint: "MinerU 的产物文件名随版本变化，若引擎行为已变请反馈",
            details: { engineCode: "artifact_missing", outputDir },
          },
          warnings,
        );
      }

      return {
        ok: true,
        engine: "mineru",
        // ⚠️ 权威档位来自产物（`extensions.mineru.tier`），不是请求值。
        tier: scan.tier ?? tier,
        ...(decision.degradedFrom !== undefined ? { degradedFrom: decision.degradedFrom } : {}),
        output: {
          outputDir,
          ...(scan.markdownPath !== undefined ? { markdownPath: scan.markdownPath } : {}),
          ...(scan.structuredContentPath !== undefined
            ? { structuredContentPath: scan.structuredContentPath }
            : {}),
          ...(scan.middleJsonPath !== undefined ? { middleJsonPath: scan.middleJsonPath } : {}),
          ...(scan.assetsDir !== undefined ? { assetsDir: scan.assetsDir } : {}),
        },
        warnings,
        durationMs: Date.now() - startedAt,
        // ⚠️ 引擎 stdout 是人读文本（`已解析 1 个输入。`），**不是 JSON** ——
        // 只能当进度信息透出，CLI 负责把它写到 stderr（验收 A10）。
        ...(run.stdout.trim() === "" ? {} : { stdout: run.stdout }),
      };
    } catch (error) {
      return this.failure(
        startedAt,
        {
          code: "process_failed",
          message: "解析产物处理失败",
          hint: error instanceof Error ? error.message : String(error),
          details: { engineCode: "process_failed" },
        },
        warnings,
      );
    } finally {
      await this.removeTempArchive(archivePath);
    }
  }

  /**
   * 下载目标档位的模型权重。
   *
   * ⚠️ **代理剥离只在这里生效**（spec §7.9）：SOCKS 代理会让 MinerU 的 httpx 直接失败
   * （缺 `socksio`）。解析子进程不受影响 —— 它是纯本地推理。
   */
  async downloadModels(request: LocalModelsDownloadRequest): Promise<LocalModelsDownloadResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];

    const located = await locateMineruKit({ configuredPath: this.deps.config?.mineruPath });
    if (located.engine === undefined) {
      return {
        ok: false,
        error: {
          code: "engine_unavailable",
          message: located.reason ?? "未找到 mineru-kit 可执行文件",
          hint: `安装：${MINERU_INSTALL_HINT}`,
          details: { engineCode: "engine_unavailable", searched: located.searched },
        },
        warnings,
        durationMs: Date.now() - startedAt,
      };
    }

    const args = ["models", "download", "--tier", request.tier];
    if (request.source !== undefined && request.source !== "auto") {
      args.push("--source", request.source);
    }

    const proxyPolicy = this.deps.config?.mineruProxy ?? "strip";
    const run = await runMineruCli(
      {
        executable: located.engine.path,
        args,
        timeoutMs: MODELS_DOWNLOAD_TIMEOUT_MS,
        stripProxy: proxyPolicy === "strip",
      },
      this.deps.execution,
    );

    if (run.timedOut) {
      return {
        ok: false,
        error: {
          code: "timeout",
          message: "模型下载超时",
          details: { engineCode: "timeout", timeoutMs: MODELS_DOWNLOAD_TIMEOUT_MS },
        },
        warnings,
        durationMs: Date.now() - startedAt,
      };
    }
    if (!run.ok) {
      return {
        ok: false,
        error: {
          code: "process_failed",
          message: `模型下载失败（退出码 ${run.exitCode ?? "未知"}）`,
          ...(run.stderr.trim() === "" ? {} : { hint: tailText(run.stderr, STDERR_TAIL_LIMIT) }),
          details: {
            engineCode: "process_failed",
            exitCode: run.exitCode,
            stderr: tailText(run.stderr, STDERR_TAIL_LIMIT),
          },
        },
        warnings,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      engine: "mineru",
      tier: request.tier,
      warnings,
      durationMs: Date.now() - startedAt,
      stdout: run.stdout,
    };
  }

  /** 输入校验：文件存在 + 类型受支持。 */
  private async validateInput(inputPath: string): Promise<LocalInfraError | undefined> {
    let kind: string;
    try {
      kind = (await this.deps.fileSystem.stat({ path: inputPath })).kind;
    } catch {
      return {
        code: "input_invalid",
        message: `文件不存在：${inputPath}`,
        details: { engineCode: "input_invalid", reason: "not_found", path: inputPath },
      };
    }
    if (kind !== "file") {
      return {
        code: "input_invalid",
        message: `输入不是一个文件：${inputPath}`,
        details: { engineCode: "input_invalid", reason: "not_found", path: inputPath },
      };
    }

    const extension = extname(inputPath).toLowerCase();
    if (extension === ".pdf") return undefined;
    if (SUPPORTED_IMAGE_EXTENSIONS.includes(extension)) return undefined;
    return {
      code: "input_invalid",
      message: `不支持的文件类型：${extension || "(无扩展名)"}`,
      hint: "本地解析只支持 PDF 与常见图片格式",
      details: { engineCode: "input_invalid", reason: "unsupported_input", path: inputPath },
    };
  }

  /** 超时预算 = 冷启动基线 + 页数 × 单位额度（spec §7.8）。 */
  private parseTimeoutMs(pageCount: number, tier: MineruTier | undefined): number {
    const perPage = TIER_SECONDS_PER_PAGE[tier ?? "standard"] * 1000;
    return PARSE_COLD_START_BUDGET_MS + pageCount * perPage;
  }

  /** 页数取不到（图片 / 无 poppler / PDF 读失败）时按 1 页计。 */
  private async resolvePageCount(path: string, isPdf: boolean): Promise<number | undefined> {
    if (!isPdf) return undefined;
    const pdf = this.deps.pdf;
    if (pdf === undefined) return undefined;
    try {
      const count = await pdf.getPageCount({
        filePath: path,
        trace: { traceId: createTraceId() },
      });
      return count !== undefined && count > 0 ? count : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 读引擎版本。
   * ⚠️ `mineru` 与 `mineru-kit` 是**两个不重叠的 CLI**：优先用同目录 sibling 的
   * `mineru version --json`（结构化），拿不到就退回 `mineru-kit --version`（人读文本）。
   */
  private async readEngineVersion(
    kitPath: string,
    versionToolPath: string | undefined,
  ): Promise<string | undefined> {
    if (versionToolPath !== undefined) {
      const result = await runMineruCli(
        {
          executable: versionToolPath,
          args: ["version", "--json"],
          timeoutMs: VERSION_CHECK_TIMEOUT_MS,
          stripProxy: false,
        },
        this.deps.execution,
      );
      if (result.ok) {
        const parsed = parseJsonObject(result.stdout);
        const version = parsed?.mineru_version;
        if (typeof version === "string") return version;
      }
    }
    const fallback = await runMineruCli(
      {
        executable: kitPath,
        args: ["--version"],
        timeoutMs: VERSION_CHECK_TIMEOUT_MS,
        stripProxy: false,
      },
      this.deps.execution,
    );
    if (!fallback.ok) return undefined;
    const match = /MinerU\s*版本[:：]\s*(?<version>\S+)/u.exec(fallback.stdout);
    return match?.groups?.version;
  }

  private async removeTempArchive(archivePath: string): Promise<void> {
    try {
      await this.deps.fileSystem.removeFile({ path: archivePath, missingOk: true });
    } catch {
      // 临时文件清理失败不影响本次解析结果。
    }
  }

  private failure(startedAt: number, error: LocalInfraError, warnings: string[]): LocalParseResult {
    return { ok: false, error, warnings, durationMs: Date.now() - startedAt };
  }
}

async function statFile(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info : undefined;
  } catch {
    return undefined;
  }
}

function tailText(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit);
}
