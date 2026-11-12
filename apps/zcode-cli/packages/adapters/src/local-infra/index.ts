import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createTraceId, MINERU_TIERS, PdfDocumentPortError } from "@zcode/contracts";
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
import { analyzeDocument } from "./analyze.js";
import { prepareOutputDir, readDocumentModelFromFile, scanArtifacts } from "./artifact-store.js";
import {
  HARDWARE_DETECT_TIMEOUT_MS,
  INCORRECT_PASSWORD_PATTERN,
  MINERU_INSTALL_HINT,
  MODELS_DOWNLOAD_TIMEOUT_MS,
  MODELS_SHOW_TIMEOUT_MS,
  PARSE_COLD_START_BUDGET_MS,
  PDF_PASSWORD_REJECTED_HINT,
  PDF_PASSWORD_REQUIRED_HINT,
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
   * ⚠️ **`route: "auto"` 时走路线自决**（原生分析 vs 识别，见 analyze.ts）；
   * 缺省仍是识别路线 —— runtime 的附件 OCR 一直走识别路线，不改它的行为。
   */
  async parse(request: LocalParseRequest): Promise<LocalParseResult> {
    if (request.route === "auto") {
      return await analyzeDocument(
        {
          ...(this.deps.pdf !== undefined ? { pdf: this.deps.pdf } : {}),
          parseWithEngine: (engineRequest) => this.parseWithEngine(engineRequest),
        },
        request,
      );
    }
    return await this.parseWithEngine(request);
  }

  /** 识别路线（MinerU）的执行体。 */
  private async parseWithEngine(request: LocalParseRequest): Promise<LocalParseResult> {
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

    // ── 加密 PDF：先探状态，再决定要不要解密（spec：ocr-local.md §3.2.1）──
    // ⚠️ **必须在调引擎之前**：引擎（MinerU 4.1.7）没有密码入口，加密 PDF 直接喂进去
    // 只会得到一句 `PDFium: Incorrect password error` —— 那是「引擎崩了」的表象，
    // 不是「密码不对」的真相。⇒ 端口先把这件事说清楚，别让用户白等一次解析。
    const pdfState = await this.inspectPdf(inputPath, isPdf, request.password);
    if (pdfState.passwordRejected === true) {
      return this.failure(
        startedAt,
        {
          code: "password_protected",
          message: "PDF 密码被拒绝",
          hint: PDF_PASSWORD_REJECTED_HINT,
          details: { engineCode: "password_protected", reason: "password_rejected" },
        },
        warnings,
      );
    }
    if (pdfState.encrypted === true && request.password === undefined) {
      return this.failure(
        startedAt,
        {
          code: "password_protected",
          message: "PDF 已加密，需要密码才能解析",
          hint: PDF_PASSWORD_REQUIRED_HINT,
          details: { engineCode: "password_protected", reason: "password_required" },
        },
        warnings,
      );
    }

    const pageCount = pdfState.pageCount;
    if (pageCount === undefined) {
      warnings.push("未能取到页数，超时预算按 1 页计费");
    }
    const budget = this.parseTimeoutMs(pageCount ?? 1, tier);

    const outputDir =
      request.outputDir !== undefined ? resolve(request.outputDir) : `${inputPath}.mineru`;

    // ⚠️ **临时 zip 必须带 `.zip` 后缀**（spec §5.5）：否则 MinerU 会创建同名目录、
    // 把产物写在里面 ⇒ 引擎退出码 0 但 ZCode 找不到 zip ⇒ 误报 artifact_missing。
    const archivePath = join(tmpdir(), `zcode-mineru-${randomUUID()}.zip`);

    // ⚠️ **解密副本**：加密 PDF 时引擎拿到的是副本，不是原文件（原件不动、指纹仍取原件）。
    let engineInputPath = inputPath;
    let decryptDirectory: string | undefined;
    if (pdfState.encrypted === true && request.password !== undefined) {
      const decrypted = await this.decryptPdfCopy(inputPath, request.password);
      if (!decrypted.ok) {
        return this.failure(startedAt, decrypted.error, warnings);
      }
      engineInputPath = decrypted.path;
      decryptDirectory = decrypted.directory;
      warnings.push("已解密加密 PDF：引擎解析的是临时无密副本（用完即删）");
    }

    // ⚠️ **`parse` 是子命令，必须放在最前面** —— `mineru-kit parse <inputs>...`
    // （实测 `mineru-kit parse --help`）。漏掉它时 MinerU 会把输入路径当成
    // 未知子命令，报 `No such command '/path/to.pdf'`（退出码 2）。
    const args = ["parse", engineInputPath];
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
        // ⚠️ **引擎认不出「密码不对」** —— MinerU 没有密码入口，加密 PDF 直接喂进去
        // 只会在 PDFium 层留下 `Incorrect password error`（spec：ocr-local.md §3.2.1）。
        // ⇒ 这里把它认成 `password_protected`，别让用户以为引擎崩了。
        if (INCORRECT_PASSWORD_PATTERN.test(run.stderr)) {
          return this.failure(
            startedAt,
            {
              code: "password_protected",
              message: "PDF 已加密，引擎打不开它",
              hint:
                request.password === undefined
                  ? PDF_PASSWORD_REQUIRED_HINT
                  : "已给密码但引擎仍报密码错：可能是没装 poppler（解密走不通），请确认 PDF 密码是否正确",
              details: { engineCode: "password_protected", reason: "password_required" },
            },
            warnings,
          );
        }
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

      // ⚠️ 元素级模型**默认不产出**（体积随全文增长）；只有要写 sidecar 的调用方才要。
      const documentModel =
        request.documentModel === true && scan.structuredContentPath !== undefined
          ? await readDocumentModelFromFile(scan.structuredContentPath, {
              artifactsRoot: outputDir,
            })
          : undefined;
      if (request.documentModel === true && documentModel === undefined) {
        warnings.push("未能从结构化产物中提取元素级模型，sidecar 将缺少逐元素信息");
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
          ...(documentModel !== undefined ? { documentModel } : {}),
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
      // ⚠️ **解密副本必须删**：它是受保护的文档的明文副本，不能留在用户目录里。
      if (decryptDirectory !== undefined) {
        await removeTempDirectory(decryptDirectory);
      }
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
        // ⚠️ 预算可被调用方覆盖（第 2 步的自动路线会传自己的上限）；
        // 缺省沿用端口的 60 分钟上限 —— 权重是 0.8–1.2GB 量级。
        timeoutMs: request.timeoutMs ?? MODELS_DOWNLOAD_TIMEOUT_MS,
        stripProxy: proxyPolicy === "strip",
      },
      this.deps.execution,
      // ⚠️ 取消透传：用户取消任务时，正在下载的权重要一起停。
      request.signal,
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

  /**
   * 探 PDF 的加密状态与页数（spec：ocr-local.md §3.2.1）。
   *
   * ⚠️ **为什么要端口自己探**：引擎（MinerU 4.1.7）没有密码入口，加密 PDF 直接喂进去
   * 只会得到一句 `PDFium: Incorrect password error` —— 那是「引擎崩了」的表象，
   * 不是「密码不对」的真相。⇒ 端口在调引擎前用 poppler 把这件事说清楚。
   * ⚠️ **探不动不等于加密**：没装 poppler / PDF 读失败时返回「未知」，
   * 此时交给引擎兜底（引擎 stderr 里的 `Incorrect password` 同样归一成
   * `password_protected`）。
   */
  private async inspectPdf(
    path: string,
    isPdf: boolean,
    password: string | undefined,
  ): Promise<PdfInspection> {
    const pdf = this.deps.pdf;
    if (!isPdf || pdf === undefined) return {};
    const trace = { traceId: createTraceId() };

    if (password !== undefined) {
      let accepted: number | undefined;
      try {
        // ⚠️ 密码只经 argv 传给 poppler 子进程，不落盘、不入日志（port 约定）。
        accepted = await pdf.getPageCount({ filePath: path, password, trace });
      } catch (error) {
        if (isPasswordProtectedError(error)) return { passwordRejected: true };
        return {};
      }
      if (accepted === undefined) return {};
      // 带密码能打开 ⇒ 密码对。**这份 PDF 到底加没加密？** 再不带密码探一次 ——
      // 带对密码的探测对「加密 / 未加密」两种文件都是成功，分不出来。
      try {
        await pdf.getPageCount({ filePath: path, trace });
        return { encrypted: false, pageCount: accepted };
      } catch (error) {
        if (isPasswordProtectedError(error)) return { encrypted: true, pageCount: accepted };
        return { pageCount: accepted };
      }
    }

    try {
      const count = await pdf.getPageCount({ filePath: path, trace });
      return { encrypted: false, pageCount: count };
    } catch (error) {
      if (isPasswordProtectedError(error)) return { encrypted: true };
      return {};
    }
  }

  /**
   * 解密副本（spec：ocr-local.md §3.2.1）。
   *
   * ⚠️ 副本落在**系统临时目录**（不在用户目录里留明文），由调用方在解析结束后删。
   * ⚠️ 副本名**必须以 `.pdf` 结尾** —— `pdftocairo -pdf` 在输出名没有扩展名时会
   * 自己补 `.pdf`，副本就落到别的路径上去了。
   */
  private async decryptPdfCopy(
    path: string,
    password: string,
  ): Promise<
    { ok: true; path: string; directory: string } | { ok: false; error: LocalInfraError }
  > {
    const pdf = this.deps.pdf;
    if (pdf === undefined) {
      return {
        ok: false,
        error: {
          code: "engine_unavailable",
          message: "未接入 PDF 端口，无法解密加密 PDF",
          hint: "安装 poppler-utils 后重试",
          details: { engineCode: "engine_unavailable" },
        },
      };
    }
    let directory: string;
    try {
      directory = await mkdtemp(join(tmpdir(), "zcode-ocr-decrypt-"));
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "process_failed",
          message: "无法创建解密临时目录",
          hint: error instanceof Error ? error.message : String(error),
          details: { engineCode: "process_failed" },
        },
      };
    }
    const outputPath = join(directory, `${basename(path, extname(path)) || "document"}.pdf`);
    try {
      await pdf.decryptToFile({
        filePath: path,
        password,
        outputPath,
        trace: { traceId: createTraceId() },
      });
      return { ok: true, path: outputPath, directory };
    } catch (error) {
      await removeTempDirectory(directory);
      if (isPasswordProtectedError(error)) {
        return {
          ok: false,
          error: {
            code: "password_protected",
            message: "PDF 密码被拒绝",
            hint: PDF_PASSWORD_REJECTED_HINT,
            details: { engineCode: "password_protected", reason: "password_rejected" },
          },
        };
      }
      if (error instanceof PdfDocumentPortError && error.code === "unavailable") {
        return {
          ok: false,
          error: {
            code: "engine_unavailable",
            message: "解密加密 PDF 需要的 poppler 不可用",
            hint: error.message,
            details: { engineCode: "engine_unavailable" },
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "process_failed",
          message: "PDF 解密失败",
          hint: error instanceof Error ? error.message : String(error),
          details: { engineCode: "process_failed" },
        },
      };
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

/**
 * PDF 的加密状态探查结果（spec：ocr-local.md §3.2.1）。
 *
 * ⚠️ 三个字段都**可能缺席** —— 探不动（没装 poppler / PDF 读失败）时是「未知」，
 * 不是「未加密」。未知 ⇒ 照常调引擎，由引擎 stderr 兜底判定。
 */
interface PdfInspection {
  /** 确认加密。 */
  readonly encrypted?: boolean;
  /** 密码被拒（探的时候带了密码，poppler 说密码不对）。 */
  readonly passwordRejected?: boolean;
  /** 页数（超时预算用）。 */
  readonly pageCount?: number;
}

/** PDF 端口报的「密码不对」。 */
function isPasswordProtectedError(error: unknown): boolean {
  return error instanceof PdfDocumentPortError && error.code === "password_protected";
}

/** 删临时目录（解密副本所在处）；失败不影响本次解析结果。 */
async function removeTempDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响解析结果（它在系统临时目录里，由系统兜底回收）。
  }
}

function tailText(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit);
}
