import { isAbsolute, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import type {
  PdfLayoutAnalysis,
  PdfLayoutImageElement,
  PdfLayoutPage,
  PdfLayoutTextElement,
} from "@zcode/contracts";

/**
 * `pdftohtml -xml` 的输出解析（spec：docs/design/v2/capability-cli-blocks.md §6.7）。
 *
 * ⚠️ **为什么要自己合并成行**：poppler 给的是**文字碎片**（实测一段中文会被拆成
 * `"本地"` / `" OCR "` / `"路线验证"` 这样的片段）⇒ 直接当元素输出，一个词一段，
 * 派生的 markdown 没法读（§6.4 / §6.5）。
 */

/** 输出基名：XML 与抽出的图片都按它命名（`layout.xml` / `layout-1_1.png`）。 */
export const PDFTOHTML_OUTPUT_BASENAME = "layout";

/**
 * 同一行判定的阈值：竖直重叠 ≥ 两者较小高度的 40%。
 *
 * ⚠️ **为什么是重叠而不是「top 差值」**：不同字体的同一行 `top` 会差零点几 pt
 * （实测 16.716 vs 16.116），而相邻两行的行距可能只有几 pt ⇒ 用固定的 top 阈值
 * 会把两行并成一行。重叠比例对字号不敏感。
 */
const LINE_OVERLAP_RATIO = 0.4;

/** 文本碎片（页面坐标系里的一个片段）。 */
interface TextFragment {
  readonly text: string;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** 一行（若干碎片合并的结果）。 */
interface TextLine {
  readonly text: string;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

interface XmlElement {
  readonly [key: string]: unknown;
}

interface RawPage extends XmlElement {
  readonly text?: readonly XmlElement[];
  readonly image?: readonly XmlElement[];
}

/**
 * 解析 `pdftohtml -xml` 的输出。
 *
 * ⚠️ `trimValues: false` 是必须的 —— 默认的 trim 会把碎片尾部的空格吃掉，
 * 合并成行时词与词之间就粘在一起了。
 */
export function parsePdftohtmlXml(
  xml: string,
  options: { readonly xmlDirectory: string },
): PdfLayoutAnalysis {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    trimValues: false,
    parseTagValue: false,
    processEntities: true,
    isArray: (name) => name === "page" || name === "text" || name === "image",
  });
  const document = parser.parse(xml) as XmlElement;
  const root = document.pdf2xml as XmlElement | undefined;
  const pages = (root?.page as readonly RawPage[] | undefined) ?? [];
  return {
    pages: pages.map((page, index) => buildPage(page, index, options.xmlDirectory)),
    producer: {
      name: attribute(root, "@_producer") ?? "poppler",
      version: attribute(root, "@_version") ?? "unknown",
    },
  };
}

function buildPage(page: RawPage, pageIndex: number, xmlDirectory: string): PdfLayoutPage {
  // ⚠️ `position="absolute"` ⇒ 元素坐标是**绝对坐标**，要减去页自身的偏移。
  const pageTop = numberAttribute(page, "@_top");
  const pageLeft = numberAttribute(page, "@_left");
  const fragments = (page.text ?? [])
    .map(toFragment)
    .filter((fragment): fragment is TextFragment => fragment !== undefined);
  const texts: PdfLayoutTextElement[] = groupIntoLines(fragments).map((line) => ({
    text: line.text,
    bboxPt: [
      line.left - pageLeft,
      line.top - pageTop,
      line.left - pageLeft + line.width,
      line.top - pageTop + line.height,
    ],
  }));
  const images: PdfLayoutImageElement[] = (page.image ?? [])
    .map((image) => toImageElement(image, pageTop, pageLeft, xmlDirectory))
    .filter((image): image is PdfLayoutImageElement => image !== undefined);
  return {
    pageIndex,
    widthPt: numberAttribute(page, "@_width"),
    heightPt: numberAttribute(page, "@_height"),
    texts,
    images,
  };
}

function toFragment(element: XmlElement): TextFragment | undefined {
  const text = typeof element["#text"] === "string" ? element["#text"] : "";
  // ⚠️ 纯空白的碎片是排版噪声（实测一整行都是空格）⇒ 丢掉。
  if (text.trim() === "") return undefined;
  return {
    text,
    top: numberAttribute(element, "@_top"),
    left: numberAttribute(element, "@_left"),
    width: numberAttribute(element, "@_width"),
    height: numberAttribute(element, "@_height"),
  };
}

function toImageElement(
  element: XmlElement,
  pageTop: number,
  pageLeft: number,
  xmlDirectory: string,
): PdfLayoutImageElement | undefined {
  const src = attribute(element, "@_src");
  if (src === undefined || src.trim() === "") return undefined;
  const top = numberAttribute(element, "@_top");
  const left = numberAttribute(element, "@_left");
  const width = numberAttribute(element, "@_width");
  const height = numberAttribute(element, "@_height");
  return {
    bboxPt: [left - pageLeft, top - pageTop, left - pageLeft + width, top - pageTop + height],
    // ⚠️ `src` 在输出路径是绝对路径时就是绝对路径；相对时相对 XML 所在目录。
    imagePath: isAbsolute(src) ? src : join(xmlDirectory, src),
  };
}

/**
 * 把碎片合并成行。
 *
 * ⚠️ 碎片按 `top` 排序后逐个归入「最后一行」—— 同一行的碎片 `top` 连续，
 * 跨行时竖直重叠不足阈值 ⇒ 另起一行。
 */
function groupIntoLines(fragments: readonly TextFragment[]): TextLine[] {
  const sorted = [...fragments].sort(
    (left, right) => left.top - right.top || left.left - right.left,
  );
  const lines: { top: number; bottom: number; fragments: TextFragment[] }[] = [];
  for (const fragment of sorted) {
    const current = lines[lines.length - 1];
    if (current !== undefined && overlapsSameLine(current, fragment)) {
      current.top = Math.min(current.top, fragment.top);
      current.bottom = Math.max(current.bottom, fragment.top + fragment.height);
      current.fragments.push(fragment);
      continue;
    }
    lines.push({
      top: fragment.top,
      bottom: fragment.top + fragment.height,
      fragments: [fragment],
    });
  }
  return lines.map(toLine);
}

function overlapsSameLine(
  line: { readonly top: number; readonly bottom: number },
  fragment: TextFragment,
): boolean {
  const overlap =
    Math.min(line.bottom, fragment.top + fragment.height) - Math.max(line.top, fragment.top);
  if (overlap <= 0) return false;
  const minHeight = Math.min(line.bottom - line.top, fragment.height);
  return overlap >= minHeight * LINE_OVERLAP_RATIO;
}

function toLine(line: {
  readonly top: number;
  readonly bottom: number;
  readonly fragments: readonly TextFragment[];
}): TextLine {
  const ordered = [...line.fragments].sort((left, right) => left.left - right.left);
  const left = Math.min(...ordered.map((fragment) => fragment.left));
  const right = Math.max(...ordered.map((fragment) => fragment.left + fragment.width));
  const top = Math.min(...ordered.map((fragment) => fragment.top));
  const bottom = Math.max(...ordered.map((fragment) => fragment.top + fragment.height));
  return {
    text: normalizeLineText(ordered.map((fragment) => fragment.text).join("")),
    top,
    left,
    width: right - left,
    height: bottom - top,
  };
}

/** 行文本：空白折叠成单个空格并去掉首尾空白（碎片自带空格，拼接后可能有重复）。 */
function normalizeLineText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function attribute(element: XmlElement | undefined, name: string): string | undefined {
  const value = element?.[name];
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(element: XmlElement, name: string): number {
  const value = attribute(element, name);
  if (value === undefined) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
