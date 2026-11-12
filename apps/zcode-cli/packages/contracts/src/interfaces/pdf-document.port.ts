import type { TraceContext } from "../tracing/tracer.js";

export interface PdfDocumentPageCountRequest {
  filePath: string;
  /**
   * 加密 PDF 的解密密码；仅内存传递给 adapter 子进程参数，
   * 禁止写入事件、元数据、日志或任何持久化边界（见 message-attachments.md 密码节）。
   */
  password?: string;
  trace: TraceContext;
}

export interface PdfDocumentRenderPagesRequest extends PdfDocumentPageCountRequest {
  firstPage: number;
  lastPage: number;
}

export interface PdfDocumentRenderedPage {
  data: Uint8Array;
  mediaType: "image/jpeg";
  pageNumber: number;
}

/**
 * 解密请求（把加密 PDF 解成一份**无密副本**）。
 *
 * ⚠️ **为什么需要它**：本地解析引擎（MinerU 4.1.7）**没有密码入口** ——
 * `mineru-kit parse` 无 `--password`，Python 侧 `parse()` / `PDFDocument.__init__`
 * 也无密码参数，加密 PDF 直接喂进去必报 `PDFium: Incorrect password error`。
 * ⇒ 密码由 ZCode 自己消费：先用 poppler 解密，再把副本交给引擎。
 * 路线见 docs/design/v2/ocr-local.md §3.2.1。
 */
export interface PdfDocumentDecryptRequest {
  filePath: string;
  /**
   * 解密密码。⚠️ **只经 argv 传给子进程**，禁止写入事件、元数据、日志或任何持久化边界
   * （同 `PdfDocumentPageCountRequest.password` 的约定）。
   */
  password: string;
  /** 无密副本的落盘路径（**调用方负责**建目录与清理）。 */
  outputPath: string;
  trace: TraceContext;
}

export interface PdfDocumentDecryptedFile {
  /** 无密副本的实际路径。 */
  path: string;
  /** 副本字节数。 */
  bytes: number;
}

export type PdfDocumentErrorCode =
  | "cancelled"
  | "corrupted"
  | "io_error"
  | "page_out_of_range"
  | "password_protected"
  | "permission_denied"
  | "process_failed"
  | "timeout"
  | "unavailable";

/**
 * 原生版面分析请求（poppler `pdftohtml -xml`）。
 *
 * ⚠️ **为什么要有它**：数字版 PDF 的「页成分 + 元素位置」不需要识别引擎 ——
 * 文本层与内嵌图对象在 PDF 里本来就有。路线见
 * docs/design/v2/capability-cli-blocks.md §6.7。
 */
export interface PdfDocumentAnalyzeLayoutRequest {
  filePath: string;
  /** 加密 PDF 的密码（只经 argv 传给子进程，不落盘、不入日志）。 */
  password?: string;
  /**
   * 产物目录 —— 抽出的图片与 XML 落在这里。
   * ⚠️ **调用方负责建目录**；实现方只保证子进程把文件写进去。
   */
  outputDir: string;
  trace: TraceContext;
}

/** 原生分析给出的一个**文本行**（碎片已按竖直重叠合并成行，见 spec §6.4）。 */
export interface PdfLayoutTextElement {
  readonly text: string;
  /** 页内坐标（pt），已减去页的 `top` / `left`。 */
  readonly bboxPt: readonly [number, number, number, number];
}

/** 原生分析给出的一个**内嵌图片对象**。 */
export interface PdfLayoutImageElement {
  readonly bboxPt: readonly [number, number, number, number];
  /** 抽出的图片文件（**绝对路径**；相对产物目录的引用由调用方算）。 */
  readonly imagePath: string;
}

/** 原生分析给出的一页。 */
export interface PdfLayoutPage {
  /** **0 基**页号。 */
  readonly pageIndex: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly texts: readonly PdfLayoutTextElement[];
  readonly images: readonly PdfLayoutImageElement[];
}

/** 原生分析的结果。 */
export interface PdfLayoutAnalysis {
  readonly pages: readonly PdfLayoutPage[];
  /** 产出者（poppler 的版本，实测取自 XML 根节点的 `version`）。 */
  readonly producer: {
    readonly name: string;
    readonly version: string;
  };
}
export class PdfDocumentPortError extends Error {
  constructor(
    readonly code: PdfDocumentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfDocumentPortError";
  }
}

export interface PdfDocumentPort {
  getPageCount(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined>;
  renderPages(
    request: PdfDocumentRenderPagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentRenderedPage[]>;
  /**
   * 把加密 PDF 解成一份**无密副本**（实现方走 poppler `pdftocairo -pdf`）。
   *
   * ⚠️ 密码被拒时抛 `PdfDocumentPortError("password_protected")`；
   * ⚠️ **副本的落盘与清理由调用方负责**（端口只负责产出那个文件）。
   */
  decryptToFile(
    request: PdfDocumentDecryptRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentDecryptedFile>;
  /**
   * **原生版面分析**：从 PDF 的文本层与内嵌图对象拿页尺寸 + 元素位置 + 文本内容。
   *
   * ⚠️ 实现方走 poppler 的 `pdftohtml -xml`（实测见 spec §6.7）；
   * ⚠️ **加密 PDF 直接支持**（poppler 的 `-upw` / `-opw`）⇒ 不需要解密副本；
   * ⚠️ 缺 poppler 时抛 `PdfDocumentPortError("unavailable")`。
   */
  analyzeLayout(
    request: PdfDocumentAnalyzeLayoutRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfLayoutAnalysis>;
}
