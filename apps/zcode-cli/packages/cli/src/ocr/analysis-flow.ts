import { basename, join, resolve } from "node:path";
import type {
  CapabilityBlockId,
  CapabilityEnvelope,
  FileSystemPort,
  LocalInfraPort,
  LocalParseResult,
  MineruTier,
  OcrSidecar,
  OcrSidecarPage,
} from "@zcode/contracts";
import { OCR_NATIVE_ANALYSIS_ROUTE, OCR_NATIVE_ANALYSIS_TIER } from "@zcode/contracts";
import {
  buildFailureEnvelope,
  buildOcrSidecar,
  deriveOcrMarkdown,
  evaluateOcrSidecarCache,
  normalizeLocalInfraError,
  ocrSidecarLocationFor,
  type OcrSidecarLocation,
} from "@zcode/core";
import { createReporter, type OcrContext, type OcrReporter } from "./output.js";
import {
  fingerprintSource,
  loadOcrSidecar,
  relativePathFrom,
  writeOcrSidecar,
} from "./sidecar-store.js";

// ============================================================
// 分析流水线 —— `ocr.inspect` 与 `ocr.parse` 共用同一条
// ============================================================
//
// ⚠️ **两个积木只是「要的产物不同」，流程是同一条**（spec §3.1 / §6.5）：
// 指纹 → 缓存判定 → （未命中）跑引擎 → 写 sidecar →（`parse`）保证 markdown 存在。
// ⇒ 接力（`inspect` → `parse`）天然命中，不会重跑引擎。
//
// ⚠️ **路线由输入自决**（spec §3.1）：数字版 PDF 走原生分析（不烧权重），
// 其余走识别路线。⚠️ **runtime 的附件 OCR 不走这条流水线** —— 它不传 `route`，
// 缺省仍是识别路线（不改 runtime 的行为）。

/** 派生 markdown 的文件名（相对 `artifactsDir`）。 */
export const OCR_DERIVED_MARKDOWN_FILENAME = "markdown.md";

/** 一次分析请求。 */
export interface OcrAnalysisRequest {
  /** 待解析文件的路径（相对路径按 cwd 解析）。 */
  readonly path: string;
  /** 产物目录；不给 = 端口的缺省（`<源文件名>.mineru/`）。 */
  readonly output?: string;
  /** 档位；不给 = 端口自选。 */
  readonly tier?: string;
  /** `--force`：忽略 sidecar 缓存，强制重算并覆盖。 */
  readonly force?: boolean;
  /** 加密 PDF 的密码（**只经 argv 传递，不落盘、不入日志**）。 */
  readonly pdfPassword?: string;
}

/** 两个积木的差异（流水线是同一条，产物要求不同）。 */
export interface OcrAnalysisShape {
  /** 信封的 `key`（积木 id）。 */
  readonly key: CapabilityBlockId;
  /** `--json`（进度走 stderr）。 */
  readonly json: boolean;
  /** 是否需要逐元素文字（缓存判据 4：`parse` 要，`inspect` 不要）。 */
  readonly needsText: boolean;
  /** 是否要 markdown 产物（`parse` 要，`inspect` 不要）。 */
  readonly withMarkdown: boolean;
}

/** 分析成功的结果。 */
export interface OcrAnalysisOutcome {
  readonly cached: boolean;
  /** sidecar 的绝对路径。 */
  readonly sidecarPath: string;
  /** 产物目录，**相对 sidecar 所在目录**。 */
  readonly artifactsDir: string;
  /** 引擎名（`"mineru"` | `"pdf-native"`）。 */
  readonly engine: string;
  /** 档位（原生分析路线恒为 `"native"`）。 */
  readonly tier: string;
  /** 产物引用（**相对 `artifactsDir`**）。 */
  readonly artifacts: Record<string, string>;
  /**
   * 逐页成分 + 逐元素。
   * ⚠️ **带 `text`** —— 投影到 `inspect` 的 `output` 时由调用方去掉（§5.8）。
   */
  readonly pages: readonly OcrSidecarPage[];
  readonly warnings: readonly string[];
  readonly durationMs: number;
  readonly degradedFrom?: string;
}

export type OcrAnalysisResult =
  | { readonly ok: true; readonly outcome: OcrAnalysisOutcome }
  | { readonly ok: false; readonly envelope: CapabilityEnvelope };

/**
 * 跑一次分析（`inspect` 与 `parse` 共用）。
 *
 * ⚠️ **失败时返回的是已经组装好的失败信封** —— 错误码的归一只有一处（core 的
 * `normalizeLocalInfraError`），命令面不再二次映射。
 */
export async function runOcrAnalysis(
  ctx: OcrContext,
  port: LocalInfraPort,
  fileSystem: FileSystemPort,
  request: OcrAnalysisRequest,
  shape: OcrAnalysisShape,
): Promise<OcrAnalysisResult> {
  const reporter = createReporter(ctx, shape.json);
  const sourcePath = resolve(request.path);
  const location = ocrSidecarLocationFor(sourcePath);
  const warnings: string[] = [];

  // ── 1. 源文件的**内容**指纹（spec §6.5 判据 2）──
  const fingerprintResult = await fingerprintSource(fileSystem, sourcePath);
  if (!fingerprintResult.ok && fingerprintResult.reason === "not_found") {
    return {
      ok: false,
      envelope: buildFailureEnvelope(
        shape.key,
        {
          code: "not_found",
          message: `文件不存在：${sourcePath}`,
          hint: "确认路径后再试；--path 传的是待解析文件的路径",
          details: { reason: "not_found" },
        },
        { durationMs: 0, warnings },
      ),
    };
  }
  const fingerprint = fingerprintResult.ok ? fingerprintResult.fingerprint : undefined;
  if (fingerprint === undefined) {
    // ⚠️ **指纹取不到不是失败**：解析照做，只是没有缓存可命中、也不写 sidecar。
    warnings.push("源文件过大或不可读，未计算内容指纹：本次不做缓存命中判断，也不写 sidecar");
  }

  // ── 2. 缓存判定（`--force` 跳过全部判据）──
  let cachedSidecar: OcrSidecar | undefined;
  if (request.force === true) {
    warnings.push("已指定 --force：忽略 sidecar 缓存，强制重算并覆盖 sidecar");
  } else if (fingerprint !== undefined) {
    const existing = await loadOcrSidecar(fileSystem, location.path);
    const decision = evaluateOcrSidecarCache(existing, {
      sourceSha256: fingerprint.sha256,
      ...(request.tier !== undefined ? { tier: request.tier } : {}),
      needsText: shape.needsText,
    });
    if (decision.hit && existing !== undefined) {
      cachedSidecar = existing;
      reporter.progress("analyze", "命中 sidecar 缓存，未重新分析");
    } else if (decision.reason !== undefined) {
      warnings.push(`缓存未命中：${decision.reason}`);
    }
  }

  // ── 3. 命中 ⇒ 复用 sidecar（**不重跑引擎**）──
  if (cachedSidecar !== undefined) {
    return await finishFromSidecar({
      fileSystem,
      location,
      shape,
      request,
      sidecar: cachedSidecar,
      warnings,
      reporter,
    });
  }

  // ── 4. 未命中 ⇒ 跑引擎 ──
  reporter.progress("analyze", `开始解析：${sourcePath}`);
  const result = await port.parse({
    path: sourcePath,
    ...(request.output !== undefined ? { outputDir: request.output } : {}),
    ...(request.tier !== undefined
      ? {
          // 端口会在运行时校验档位枚举（§5.2 的 `engine_not_found`），
          // 这里刻意不做预校验，避免同一份校验逻辑出现两个来源。
          tier: request.tier as MineruTier,
        }
      : {}),
    // ⚠️ **sidecar 需要逐元素信息** ⇒ 这里必须要元素级模型（体积换接力能力）。
    documentModel: true,
    ...(request.pdfPassword !== undefined ? { password: request.pdfPassword } : {}),
    // ⚠️ **路线由输入自决**（spec §3.1）：数字版 PDF 走原生分析，其余走识别。
    route: "auto",
  });
  // ⚠️ **进度信息只走 stderr**（spec §5.6）：引擎自己的 stdout 是人读文本
  // （`已解析 1 个输入。`），**不能混进 stdout 的 JSON**。
  if (result.stdout !== undefined && result.stdout.trim() !== "") {
    reporter.progress("analyze", result.stdout.trim());
  }

  if (!result.ok) {
    return {
      ok: false,
      envelope: buildFailureEnvelope(
        shape.key,
        result.error !== undefined
          ? normalizeLocalInfraError(result.error)
          : { code: "internal", message: "解析失败，但端口没有给出错误详情" },
        {
          durationMs: result.durationMs,
          warnings: [...warnings, ...result.warnings],
          ...(result.degradedFrom !== undefined ? { degradedFrom: result.degradedFrom } : {}),
        },
      ),
    };
  }

  // ── 5. 组装 sidecar（spec §6）──
  const artifactsDir = result.output?.outputDir;
  if (artifactsDir === undefined) {
    return {
      ok: false,
      envelope: buildFailureEnvelope(
        shape.key,
        { code: "internal", message: "解析成功，但端口没有给出产物目录" },
        { durationMs: result.durationMs, warnings: [...warnings, ...result.warnings] },
      ),
    };
  }
  const route = result.route ?? "mineru";
  const engineName =
    route === OCR_NATIVE_ANALYSIS_ROUTE ? OCR_NATIVE_ANALYSIS_ROUTE : (result.engine ?? "mineru");
  const tier =
    route === OCR_NATIVE_ANALYSIS_ROUTE ? OCR_NATIVE_ANALYSIS_TIER : (result.tier ?? "unknown");
  const artifacts = artifactReferences(result, artifactsDir);
  const model = result.output?.documentModel;
  let sidecar: OcrSidecar | undefined;
  if (model === undefined) {
    warnings.push("未能提取逐元素模型：本次不写 sidecar（下一次调用会重新解析）");
  } else {
    sidecar = buildOcrSidecar({
      source: {
        // ⚠️ **相对 sidecar 所在目录**（sidecar 就在源文件旁 ⇒ 基名）。
        path: basename(sourcePath),
        sha256: fingerprint?.sha256 ?? "",
        bytes: fingerprint?.bytes ?? 0,
        mtimeMs: fingerprint?.mtimeMs ?? 0,
      },
      engine: {
        name: engineName,
        variant: engineName,
        version: model.producer?.version ?? "unknown",
        // ⚠️ **权威档位来自产物**，不是请求值（端口已回填）。
        tier,
        route,
        assets: {},
      },
      artifactsDir: relativePathFrom(location.directory, artifactsDir),
      pages: model.pages,
    });

    // ── 6. markdown 产物（spec §6.5 的写死口径）──
    if (shape.withMarkdown) {
      const engineMarkdown = result.output?.markdownPath;
      if (engineMarkdown !== undefined) {
        // 识别路线：引擎已产出 markdown ⇒ 直接复用，**不重新派生**。
        sidecar = {
          ...sidecar,
          text: { markdownPath: relativePathFrom(artifactsDir, engineMarkdown) },
        };
      } else {
        // 原生分析路线：引擎没有产物 ⇒ 从 sidecar 的元素派生一份。
        await writeDerivedMarkdown(fileSystem, artifactsDir, sidecar);
        sidecar = { ...sidecar, text: { markdownPath: OCR_DERIVED_MARKDOWN_FILENAME } };
        artifacts.markdownPath = OCR_DERIVED_MARKDOWN_FILENAME;
        reporter.progress(
          "write",
          `派生 markdown：${join(artifactsDir, OCR_DERIVED_MARKDOWN_FILENAME)}`,
        );
      }
    }

    if (fingerprint !== undefined) {
      reporter.progress("write", `写入 sidecar：${location.path}`);
      await writeOcrSidecar(fileSystem, location.path, sidecar);
    }
  }

  return {
    ok: true,
    outcome: {
      cached: false,
      sidecarPath: location.path,
      artifactsDir: relativePathFrom(location.directory, artifactsDir),
      engine: engineName,
      tier,
      artifacts,
      pages: sidecar?.pages ?? [],
      warnings: [...warnings, ...result.warnings],
      durationMs: result.durationMs,
      ...(result.degradedFrom !== undefined ? { degradedFrom: result.degradedFrom } : {}),
    },
  };
}

/**
 * 缓存命中 ⇒ 直接用 sidecar 出结果（**不重跑引擎**）。
 *
 * ⚠️ **命中不等于什么都不做**：`parse` 仍要保证 markdown 产物存在
 * （sidecar 是 `inspect` 写的时候没有 markdown ⇒ 这里派生一份）。
 */
async function finishFromSidecar(input: {
  readonly fileSystem: FileSystemPort;
  readonly location: OcrSidecarLocation;
  readonly shape: OcrAnalysisShape;
  readonly request: OcrAnalysisRequest;
  readonly sidecar: OcrSidecar;
  readonly warnings: string[];
  readonly reporter: OcrReporter;
}): Promise<OcrAnalysisResult> {
  const { fileSystem, location, shape, request, sidecar } = input;
  const warnings = [...input.warnings];
  const artifactsDir = join(location.directory, sidecar.artifactsDir);
  const artifacts: Record<string, string> = {};

  // ⚠️ **业务要看得见实际用的是哪一档**（spec §6.5 判据 3）。
  if (sidecar.engine.route === OCR_NATIVE_ANALYSIS_ROUTE) {
    warnings.push(
      "本次用的是 PDF 原生分析路线（sidecar 里的档位 native）—— 原生路线不消耗模型权重",
    );
  } else if (request.tier === undefined) {
    warnings.push(`本次用的是 sidecar 里的档位 ${sidecar.engine.tier}`);
  }

  let finalSidecar = sidecar;
  if (shape.withMarkdown) {
    const markdown = await ensureMarkdown(fileSystem, sidecar, artifactsDir);
    artifacts.markdownPath = markdown.relativePath;
    warnings.push(...markdown.warnings);
    if (markdown.sidecar !== sidecar) {
      input.reporter.progress("write", `回填 sidecar 的 markdown 路径：${location.path}`);
      await writeOcrSidecar(fileSystem, location.path, markdown.sidecar);
    }
    finalSidecar = markdown.sidecar;
  }

  return {
    ok: true,
    outcome: {
      cached: true,
      sidecarPath: location.path,
      artifactsDir: sidecar.artifactsDir,
      engine: sidecar.engine.name,
      tier: sidecar.engine.tier,
      artifacts,
      pages: finalSidecar.pages,
      warnings,
      durationMs: 0,
    },
  };
}

/**
 * 保证 markdown 产物存在。
 *
 * - sidecar 记了 `text.markdownPath` **且文件在** ⇒ 复用；
 * - 否则 ⇒ 从 sidecar 的元素派生，写到 `<产物目录>/markdown.md`，并回填 sidecar。
 */
async function ensureMarkdown(
  fileSystem: FileSystemPort,
  sidecar: OcrSidecar,
  artifactsDir: string,
): Promise<{
  readonly relativePath: string;
  readonly sidecar: OcrSidecar;
  readonly warnings: string[];
}> {
  const recorded = sidecar.text?.markdownPath;
  if (recorded !== undefined && (await fileExists(fileSystem, join(artifactsDir, recorded)))) {
    return { relativePath: recorded, sidecar, warnings: [] };
  }
  const warnings: string[] = [];
  if (recorded !== undefined) {
    warnings.push("sidecar 记的 markdown 产物已丢失，已从元素重新派生");
  }
  await writeDerivedMarkdown(fileSystem, artifactsDir, sidecar);
  return {
    relativePath: OCR_DERIVED_MARKDOWN_FILENAME,
    sidecar: { ...sidecar, text: { markdownPath: OCR_DERIVED_MARKDOWN_FILENAME } },
    warnings,
  };
}

/** 从 sidecar 的元素派生 markdown（spec §6.5 的派生规则）。 */
async function writeDerivedMarkdown(
  fileSystem: FileSystemPort,
  artifactsDir: string,
  sidecar: OcrSidecar,
): Promise<void> {
  await fileSystem.writeTextFile({
    path: join(artifactsDir, OCR_DERIVED_MARKDOWN_FILENAME),
    content: deriveOcrMarkdown(sidecar),
    atomic: true,
    createParents: true,
  });
}

/** 产物引用（**相对 `artifactsDir`**）。 */
function artifactReferences(
  result: LocalParseResult,
  artifactsDir: string,
): Record<string, string> {
  const output = result.output;
  const references: Record<string, string> = {};
  if (output?.markdownPath !== undefined) {
    references.markdownPath = relativePathFrom(artifactsDir, output.markdownPath);
  }
  if (output?.structuredContentPath !== undefined) {
    references.structuredContentPath = relativePathFrom(artifactsDir, output.structuredContentPath);
  }
  if (output?.middleJsonPath !== undefined) {
    references.middleJsonPath = relativePathFrom(artifactsDir, output.middleJsonPath);
  }
  if (output?.assetsDir !== undefined) {
    references.assetsDir = relativePathFrom(artifactsDir, output.assetsDir);
  }
  return references;
}

/** 文件在不在（读不到就当不在 —— 缓存只是加速手段，不该让命令失败）。 */
async function fileExists(fileSystem: FileSystemPort, path: string): Promise<boolean> {
  try {
    await fileSystem.stat({ path });
    return true;
  } catch {
    return false;
  }
}
