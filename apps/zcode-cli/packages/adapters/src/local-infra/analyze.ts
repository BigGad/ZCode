import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  createTraceId,
  OCR_NATIVE_ANALYSIS_ROUTE,
  OCR_NATIVE_ANALYSIS_TIER,
  PdfDocumentPortError,
  type LocalAnalysisRoute,
  type LocalDocumentElement,
  type LocalDocumentModel,
  type LocalDocumentPage,
  type LocalInfraError,
  type LocalParseRequest,
  type LocalParseResult,
  type PdfDocumentPort,
  type PdfLayoutAnalysis,
} from "@zcode/contracts";
import { PDF_PASSWORD_REJECTED_HINT, PDF_PASSWORD_REQUIRED_HINT } from "./constants.js";

// ============================================================
// 分析路线自决 —— PDF 原生分析 vs 识别
// ============================================================
//
// ⚠️ **路线由输入类型决定，不由调用方指定**（spec：docs/design/v2/capability-cli-blocks.md §3.1）。
// ⚠️ 原生分析的实现与实测依据见同一份 spec 的 §6.7（poppler 的 `pdftohtml -xml`）。

/** 原生分析路线的档位名（写进 sidecar 的 `engine.tier`）。 */
export const NATIVE_ANALYSIS_TIER = OCR_NATIVE_ANALYSIS_TIER;

/** 原生分析路线给出的引擎名（写进 sidecar 的 `engine.name`）。 */
export const NATIVE_ANALYSIS_ENGINE = OCR_NATIVE_ANALYSIS_ROUTE;

/** poppler 不可用时的说明（**必须显式告知**——静默退到识别路线会让业务多付权重代价）。 */
export const POPPLER_MISSING_WARNING =
  "未检测到 poppler（pdftohtml），无法走 PDF 原生分析路线，本次走识别路线；若文档是数字版 PDF，会多付一次权重代价";

/** 扫描页整页图的存放目录（相对产物目录）。 */
const RENDERED_PAGES_DIR = "images";

/** 路线判定的结果。 */
export interface AnalysisRouteDecision {
  readonly route: LocalAnalysisRoute;
  /** 人话说明（进 `metrics.warnings`）。 */
  readonly reason: string;
}

/** 分析流程需要的依赖。 */
export interface AnalyzeDocumentDeps {
  /** PDF 端口；不给 = 没有 poppler ⇒ 判不出路线。 */
  readonly pdf?: PdfDocumentPort;
  /** 识别路线（MinerU）的执行体 —— 由 adapter 提供（它才有引擎定位与档位判定）。 */
  readonly parseWithEngine: (request: LocalParseRequest) => Promise<LocalParseResult>;
}

/** 原生分析的探测结果。 */
interface NativeProbe {
  readonly analysis?: PdfLayoutAnalysis;
  /** poppler 不可用时的说明。 */
  readonly warning?: string;
  /** 探测失败（密码 / 损坏 / 超时）—— 直接报错，不退到识别路线。 */
  readonly error?: LocalInfraError;
}

/**
 * 路线判定（纯函数，可单测）。
 *
 * ⚠️ **判据是「每一页都有文本层」** —— 只要有一页没有文本层（扫描页 / 空白页），
 * 整份文档就走识别路线：引擎的输入是整份文档，逐页混排会让页号对不上。
 * ⚠️ **宁可多算，不可漏页**（代价：一份「99 页数字版 + 1 页扫描件」会整份走识别）。
 */
export function decideAnalysisRoute(
  analysis: PdfLayoutAnalysis | undefined,
): AnalysisRouteDecision {
  if (analysis === undefined) {
    return { route: "mineru", reason: POPPLER_MISSING_WARNING };
  }
  const pagesWithoutText = analysis.pages.filter((page) => page.texts.length === 0);
  if (pagesWithoutText.length === 0) {
    return {
      route: "pdf-native",
      reason: "文档每一页都有文本层，走 PDF 原生分析路线（不消耗模型权重）",
    };
  }
  return {
    route: "mineru",
    reason: `文档有 ${pagesWithoutText.length} 页没有文本层（扫描页或空白页），走识别路线`,
  };
}

/**
 * 走「路线自决」的解析（`LocalParseRequest.route === "auto"`）。
 *
 * ⚠️ **runtime 的附件 OCR 走不到这里** —— 它不传 `route`，缺省仍是识别路线。
 */
export async function analyzeDocument(
  deps: AnalyzeDocumentDeps,
  request: LocalParseRequest,
): Promise<LocalParseResult> {
  const startedAt = Date.now();
  const inputPath = resolve(request.path);
  const outputDir =
    request.outputDir !== undefined ? resolve(request.outputDir) : `${inputPath}.mineru`;
  const warnings: string[] = [];

  // ── 1. 原生分析（探测 + 可能的产物）──
  const probe = await probeNativeAnalysis(deps.pdf, inputPath, outputDir, request);
  if (probe.error !== undefined) {
    return {
      ok: false,
      error: probe.error,
      warnings,
      durationMs: Date.now() - startedAt,
    };
  }
  if (probe.warning !== undefined) warnings.push(probe.warning);

  // ── 2. 路线判定 ──
  const decision = decideAnalysisRoute(probe.analysis);
  warnings.push(decision.reason);
  if (decision.route === "pdf-native" && probe.analysis !== undefined) {
    return {
      ok: true,
      route: "pdf-native",
      output: {
        outputDir,
        documentModel: toNativeDocumentModel(probe.analysis, outputDir),
      },
      warnings,
      durationMs: Date.now() - startedAt,
    };
  }

  // ── 3. 识别路线 ──
  const engineResult = await deps.parseWithEngine({ ...request, route: "mineru" });
  if (!engineResult.ok) {
    return {
      ...engineResult,
      warnings: [...warnings, ...engineResult.warnings],
    };
  }
  const engineWarnings = [...warnings, ...engineResult.warnings];
  const model = engineResult.output?.documentModel;
  const engineOutput = engineResult.output;
  if (model === undefined || probe.analysis === undefined || engineOutput === undefined) {
    return { ...engineResult, route: "mineru", warnings: engineWarnings };
  }

  // ── 4. 扫描页补整页图（`origin: "rendered"`）──
  const rendered = await attachRenderedScanPages({
    pdf: deps.pdf,
    inputPath,
    outputDir,
    request,
    analysis: probe.analysis,
    model,
  });
  return {
    ...engineResult,
    route: "mineru",
    output: {
      ...engineOutput,
      documentModel: rendered.model,
    },
    warnings: [...engineWarnings, ...rendered.warnings],
  };
}

/** 原生分析探测（PDF 才需要；图片输入没有原生路线）。 */
async function probeNativeAnalysis(
  pdf: PdfDocumentPort | undefined,
  inputPath: string,
  outputDir: string,
  request: LocalParseRequest,
): Promise<NativeProbe> {
  if (pdf === undefined) return { warning: POPPLER_MISSING_WARNING };
  if (!isPdfPath(inputPath)) return {};
  try {
    const analysis = await pdf.analyzeLayout({
      filePath: inputPath,
      outputDir,
      ...(request.password !== undefined ? { password: request.password } : {}),
      trace: { traceId: createTraceId() },
    });
    return { analysis };
  } catch (error) {
    if (error instanceof PdfDocumentPortError && error.code === "unavailable") {
      return { warning: POPPLER_MISSING_WARNING };
    }
    // ⚠️ 密码错 / 文件损坏 / 超时 ⇒ 直接报错。
    // **不退到识别路线**：识别路线同样读不了这个文件，退过去只是多烧一次权重。
    return { error: toLocalInfraError(error, request.password !== undefined) };
  }
}

/** 原生分析的页模型 → 引擎无关的元素模型（sidecar 的输入）。 */
function toNativeDocumentModel(analysis: PdfLayoutAnalysis, outputDir: string): LocalDocumentModel {
  const pages: LocalDocumentPage[] = analysis.pages.map((page) => {
    const elements: LocalDocumentElement[] = [];
    if (page.widthPt > 0 && page.heightPt > 0) {
      for (const text of page.texts) {
        elements.push({
          type: "text",
          bbox: normalizeBbox(text.bboxPt, page.widthPt, page.heightPt),
          text: text.text,
          origin: "engine",
        });
      }
      for (const image of page.images) {
        elements.push({
          type: "image",
          bbox: normalizeBbox(image.bboxPt, page.widthPt, page.heightPt),
          imagePath: relativePathWithin(outputDir, image.imagePath),
          origin: "engine",
        });
      }
    }
    return {
      pageIndex: page.pageIndex,
      widthPt: page.widthPt,
      heightPt: page.heightPt,
      status: "ok",
      elements,
    };
  });
  return {
    pages,
    producer: { name: NATIVE_ANALYSIS_ENGINE, version: analysis.producer.version },
  };
}

/**
 * 扫描页补整页图。
 *
 * ⚠️ **「扫描页」的判据**：没有文本层、但**有内嵌图**的页（整页扫描件就是一张位图）。
 * ⚠️ **没有文本也没有图的页不算扫描页** —— 它是空白页（§6.4 的 `empty`），
 * 给它合成一张整页图会把「空白」说成「图片页」。
 */
async function attachRenderedScanPages(input: {
  readonly pdf: PdfDocumentPort | undefined;
  readonly inputPath: string;
  readonly outputDir: string;
  readonly request: LocalParseRequest;
  readonly analysis: PdfLayoutAnalysis;
  readonly model: LocalDocumentModel;
}): Promise<{ readonly model: LocalDocumentModel; readonly warnings: string[] }> {
  const warnings: string[] = [];
  const scanPages = input.analysis.pages.filter(
    (page) => page.texts.length === 0 && page.images.length > 0,
  );
  if (scanPages.length === 0) return { model: input.model, warnings };
  if (input.pdf === undefined) {
    warnings.push(
      `文档有 ${scanPages.length} 页扫描页，但缺 poppler（pdftoppm）⇒ 拿不到整页图（页成分仍由引擎给）`,
    );
    return { model: input.model, warnings };
  }

  const renderedByPage = new Map<number, string>();
  for (const run of contiguousRuns(scanPages.map((page) => page.pageIndex))) {
    try {
      const rendered = await input.pdf.renderPages({
        filePath: input.inputPath,
        firstPage: run.start + 1,
        lastPage: run.end + 1,
        ...(input.request.password !== undefined ? { password: input.request.password } : {}),
        trace: { traceId: createTraceId() },
      });
      await mkdir(join(input.outputDir, RENDERED_PAGES_DIR), { recursive: true });
      for (const page of rendered) {
        const relativePath = `${RENDERED_PAGES_DIR}/page-${page.pageNumber}.jpg`;
        await writeFile(join(input.outputDir, relativePath), page.data);
        renderedByPage.set(page.pageNumber - 1, relativePath);
      }
    } catch (error) {
      warnings.push(
        `渲染第 ${run.start + 1}-${run.end + 1} 页的整页图失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (renderedByPage.size === 0) return { model: input.model, warnings };

  const pages = input.model.pages.map((page) => {
    const relativePath = renderedByPage.get(page.pageIndex);
    if (relativePath === undefined) return page;
    const renderedElement: LocalDocumentElement = {
      type: "page",
      bbox: [0, 0, 1, 1],
      imagePath: relativePath,
      origin: "rendered",
    };
    // ⚠️ 整页图是**底图** ⇒ 放在元素列表的最前面。
    return { ...page, elements: [renderedElement, ...page.elements] };
  });
  // ⚠️ 引擎没给出这一页时补一页（否则扫描页的内容就丢了）。
  const known = new Set(pages.map((page) => page.pageIndex));
  for (const [pageIndex, relativePath] of renderedByPage) {
    if (known.has(pageIndex)) continue;
    const nativePage = input.analysis.pages.find((page) => page.pageIndex === pageIndex);
    pages.push({
      pageIndex,
      widthPt: nativePage?.widthPt ?? 0,
      heightPt: nativePage?.heightPt ?? 0,
      status: "ok",
      elements: [{ type: "page", bbox: [0, 0, 1, 1], imagePath: relativePath, origin: "rendered" }],
    });
  }
  pages.sort((left, right) => left.pageIndex - right.pageIndex);
  return { model: { ...input.model, pages }, warnings };
}

/** 连续页号分段（一次 `pdftoppm` 渲一段，别一页一次调用）。 */
function contiguousRuns(pageIndexes: readonly number[]): { start: number; end: number }[] {
  const sorted = [...pageIndexes].sort((left, right) => left - right);
  const runs: { start: number; end: number }[] = [];
  for (const pageIndex of sorted) {
    const current = runs[runs.length - 1];
    if (current !== undefined && pageIndex === current.end + 1) {
      current.end = pageIndex;
      continue;
    }
    runs.push({ start: pageIndex, end: pageIndex });
  }
  return runs;
}

/** 归一化 bbox（分母是页尺寸），并裁剪到 `[0, 1]`。 */
function normalizeBbox(
  bboxPt: readonly [number, number, number, number],
  widthPt: number,
  heightPt: number,
): readonly [number, number, number, number] {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  return [
    clamp(bboxPt[0] / widthPt),
    clamp(bboxPt[1] / heightPt),
    clamp(bboxPt[2] / widthPt),
    clamp(bboxPt[3] / heightPt),
  ];
}

/** 相对产物目录的路径（统一用 `/` 分隔）。 */
function relativePathWithin(baseDirectory: string, target: string): string {
  const value = relative(resolve(baseDirectory), resolve(target));
  return value.split(sep).join("/");
}

/** PDF 的判定（与 adapter 的输入类型判定一致）。 */
function isPdfPath(path: string): boolean {
  return extname(path).toLowerCase() === ".pdf";
}

/** PDF 端口的错误 → 本地基础设施层的错误码（单向归一）。 */
function toLocalInfraError(error: unknown, hasPassword: boolean): LocalInfraError {
  if (error instanceof PdfDocumentPortError) {
    switch (error.code) {
      case "password_protected":
        return {
          code: "password_protected",
          message: hasPassword ? "PDF 密码被拒绝" : "PDF 已加密，需要密码才能解析",
          hint: hasPassword ? PDF_PASSWORD_REJECTED_HINT : PDF_PASSWORD_REQUIRED_HINT,
          details: { engineCode: "password_protected" },
        };
      case "corrupted":
        return {
          code: "document_corrupted",
          message: "PDF 文件已损坏或不是有效的 PDF",
          hint: "换一个文件再试；损坏的 PDF 无法做版面分析",
          details: { engineCode: "corrupted" },
        };
      case "permission_denied":
        return {
          code: "permission_denied",
          message: "没有权限读取该 PDF",
          details: { engineCode: "permission_denied" },
        };
      case "timeout":
        return {
          code: "timeout",
          message: "PDF 原生分析超时",
          details: { engineCode: "timeout" },
        };
      default:
        return {
          code: "process_failed",
          message: error.message,
          details: { engineCode: error.code },
        };
    }
  }
  return {
    code: "process_failed",
    message: error instanceof Error ? error.message : String(error),
    details: { engineCode: "process_failed" },
  };
}
