// ============================================================
// 产物 sidecar v3 —— 统一格式、分类规则、缓存判据
// ============================================================

import { basename, dirname, join } from "node:path";
import {
  OCR_NATIVE_ANALYSIS_ROUTE,
  OCR_SIDECAR_VERSION,
  type LocalDocumentElement,
  type LocalDocumentPage,
  type OcrElementCategory,
  type OcrSidecar,
  type OcrSidecarElement,
  type OcrSidecarPage,
} from "@zcode/contracts";

import type {
  OcrPageCompositionResult,
  OcrSidecarBuildInput,
  OcrSidecarCacheCriteria,
  OcrSidecarCacheDecision,
  OcrSidecarLocation,
} from "./contract.js";

/** sidecar 的文件名后缀：`<源文件名>.zcode-ocr.json`（**含源文件扩展名**）。 */
export const OCR_SIDECAR_SUFFIX = ".zcode-ocr.json";

/**
 * 已知 `type` → `category` 的映射表（spec §6.4）。
 *
 * ⚠️ **分类由映射表得出，不直接比较 `type` 字符串** —— `type` 随档位变
 * （standard / flash 叫 `image`，advanced 叫 `chart`）。
 * ⚠️ 表里没有的一律 `other`（**不静默吞掉**：计数进 `otherElements`，业务看得见）。
 */
export const OCR_ELEMENT_TYPE_CATEGORIES: Readonly<Record<string, OcrElementCategory>> = {
  text: "text",
  paragraph_title: "text",
  table: "text",
  image: "image",
  chart: "image",
  page: "image",
};

/** 元素的分类。 */
export function classifyOcrElementType(type: string): OcrElementCategory {
  // ⚠️ 用 `hasOwn` 而不是直接索引：`type = "constructor"` 这类键会撞到原型链上的属性。
  return Object.hasOwn(OCR_ELEMENT_TYPE_CATEGORIES, type)
    ? OCR_ELEMENT_TYPE_CATEGORIES[type]
    : "other";
}

/**
 * 页成分判定 —— 对 (hasText, hasImage, hasOther) 的**全枚举**，是全函数（spec §6.4）。
 *
 * | hasText | hasImage | hasOther | composition |
 * | F | F | F | `empty`（没有元素 ⇒ 空白页） |
 * | F | F | T | `other` |
 * | T | F | F | `text` |
 * | T | F | T | `text` |
 * | F | T | F | `image` |
 * | F | T | T | `image` |
 * | T | T | F | `text+image` |
 * | T | T | T | `text+image` |
 *
 * ⚠️ **未归类元素只进 `otherElements` 计数，不污染 composition** —— 「这页算不算纯文本页」
 * 由业务决定，zcode 不替业务决定，但**不隐瞒**。
 */
export function computeOcrPageComposition(
  elements: readonly LocalDocumentElement[],
): OcrPageCompositionResult {
  let hasText = false;
  let hasImage = false;
  let otherElements = 0;
  for (const element of elements) {
    switch (classifyOcrElementType(element.type)) {
      case "text":
        hasText = true;
        break;
      case "image":
        hasImage = true;
        break;
      default:
        otherElements += 1;
        break;
    }
  }
  if (hasText && hasImage) return { composition: "text+image", otherElements };
  if (hasText) return { composition: "text", otherElements };
  if (hasImage) return { composition: "image", otherElements };
  if (otherElements > 0) return { composition: "other", otherElements };
  return { composition: "empty", otherElements };
}

/**
 * sidecar 的落盘位置：`<源文件目录>/<源文件名>.zcode-ocr.json`。
 *
 * ⚠️ **源文件名含扩展名** —— 不是去扩展名的基名（业务拼路径时别搞错）。
 */
export function ocrSidecarLocationFor(sourcePath: string): OcrSidecarLocation {
  const directory = dirname(sourcePath);
  return {
    path: join(directory, `${basename(sourcePath)}${OCR_SIDECAR_SUFFIX}`),
    directory,
  };
}

/** 按统一格式组装 sidecar（纯函数，不落盘）。 */
export function buildOcrSidecar(input: OcrSidecarBuildInput): OcrSidecar {
  return {
    version: OCR_SIDECAR_VERSION,
    source: input.source,
    engine: input.engine,
    artifactsDir: input.artifactsDir,
    pages: input.pages.map(buildOcrSidecarPage),
    ...(input.markdownPath !== undefined ? { text: { markdownPath: input.markdownPath } } : {}),
  };
}

/**
 * 页对象。
 *
 * ⚠️ **失败页 ≠ 空白页**：分析出错的页是 `status: "failed"` + `composition: null` +
 * `elements: []`；分析成功但没东西才是 `status: "ok"` + `composition: "empty"`。
 */
function buildOcrSidecarPage(page: LocalDocumentPage): OcrSidecarPage {
  if (page.status === "failed") {
    return {
      pageIndex: page.pageIndex,
      widthPt: page.widthPt,
      heightPt: page.heightPt,
      status: "failed",
      composition: null,
      otherElements: 0,
      elements: [],
    };
  }
  const { composition, otherElements } = computeOcrPageComposition(page.elements);
  return {
    pageIndex: page.pageIndex,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    status: "ok",
    composition,
    otherElements,
    elements: page.elements.map(toSidecarElement),
  };
}

function toSidecarElement(element: LocalDocumentElement): OcrSidecarElement {
  const category = classifyOcrElementType(element.type);
  const text = resolveElementText(category, element.text);
  return {
    category,
    type: element.type,
    origin: element.origin ?? "engine",
    bbox: element.bbox,
    ...(text !== undefined ? { text } : {}),
    ...(element.imagePath !== undefined ? { imagePath: element.imagePath } : {}),
  };
}

/**
 * 元素该带什么文字。
 *
 * - **文本类**：恒带（内容为空时是空串）—— 缓存判据 4「文本类元素带 `text`」才判得清，
 *   「没有文字」与「没带字段」必须能区分。
 * - **图片类**：**不带**（spec §6.2）—— 图片本体只由 `imagePath` 指向。
 * - **未归类**：保留引擎给的文字，不隐瞒。
 */
function resolveElementText(
  category: OcrElementCategory,
  text: string | undefined,
): string | undefined {
  if (category === "text") return text ?? "";
  if (category === "image") return undefined;
  return text;
}

/**
 * 缓存命中判定（spec §6.5 的四条判据）。
 *
 * ⚠️ **命中时不重算引擎** —— 这是「业务永远只传原始路径」的前提（D5）。
 */
export function evaluateOcrSidecarCache(
  sidecar: OcrSidecar | undefined,
  criteria: OcrSidecarCacheCriteria,
): OcrSidecarCacheDecision {
  if (sidecar === undefined) {
    return { hit: false, reason: "尚无 sidecar，本次是首次解析" };
  }
  const tier = sidecar.engine.tier;
  if (sidecar.version !== OCR_SIDECAR_VERSION) {
    return {
      hit: false,
      reason: `sidecar 版本是 ${sidecar.version}，当前格式是 ${OCR_SIDECAR_VERSION}，需要重算`,
      tier,
    };
  }
  if (sidecar.source.sha256 !== criteria.sourceSha256) {
    return { hit: false, reason: "源文件内容已变化，缓存失效", tier };
  }
  if (
    criteria.tier !== undefined &&
    sidecar.engine.tier !== criteria.tier &&
    // ⚠️ **原生分析路线没有质量档位**（spec §6.5 判据 3 的 v2.3 例外）：
    // 它不烧权重，档位对它没有意义 ⇒ 判据不适用。
    // ⚠️ 若照字面执行，数字版 PDF 每次都会「档位不符 ⇒ 重算」，缓存形同虚设。
    sidecar.engine.route !== OCR_NATIVE_ANALYSIS_ROUTE
  ) {
    return {
      hit: false,
      reason: `sidecar 的档位是 ${sidecar.engine.tier}，与请求的 ${criteria.tier} 不一致，需要重算`,
      tier,
    };
  }
  if (!sidecarHasRequiredContent(sidecar, criteria.needsText)) {
    return {
      hit: false,
      reason: criteria.needsText
        ? "sidecar 里没有逐元素文字，无法直接派生正文，需要重算"
        : "sidecar 缺少页成分或元素，无法复用，需要重算",
      tier,
    };
  }
  return { hit: true, tier };
}

/**
 * sidecar 是否满足当前积木的需要。
 *
 * - `inspect`：每页有 `composition` + `elements[]`；
 * - `parse`：在上面的基础上，**每个文本类元素还要带 `text`**（否则派生不出正文）。
 */
function sidecarHasRequiredContent(sidecar: OcrSidecar, needsText: boolean): boolean {
  if (!Array.isArray(sidecar.pages) || sidecar.pages.length === 0) return false;
  for (const page of sidecar.pages) {
    if (!Array.isArray(page.elements)) return false;
    if (page.status === "failed") {
      // 失败页的 `composition` 必须是 null（不是「没成分」）。
      if (page.composition !== null) return false;
      continue;
    }
    if (typeof page.composition !== "string") return false;
    if (!needsText) continue;
    for (const element of page.elements) {
      if (element.category !== "text") continue;
      if (typeof element.text !== "string") return false;
    }
  }
  return true;
}

/**
 * 从 sidecar 的元素派生 markdown（原生分析路线没有引擎产物时用）。
 *
 * ⚠️ 规则写死（spec §6.5）：按元素顺序 —— 文本类输出 `text`，图片类输出
 * `![caption](imagePath)`，表格类（分类是 `text`）输出 `text`。
 * ⚠️ **页与页之间空一行**；空页不产出内容。
 */
export function deriveOcrMarkdown(sidecar: OcrSidecar): string {
  const pages: string[] = [];
  for (const page of sidecar.pages) {
    const chunks: string[] = [];
    for (const element of page.elements) {
      if (element.category === "image") {
        if (element.imagePath === undefined) continue;
        chunks.push(`![${element.text ?? ""}](${element.imagePath})`);
        continue;
      }
      if (typeof element.text !== "string" || element.text === "") continue;
      chunks.push(element.text);
    }
    if (chunks.length > 0) pages.push(chunks.join("\n\n"));
  }
  return pages.join("\n\n");
}
