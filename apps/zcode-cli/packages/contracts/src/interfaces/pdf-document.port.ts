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
}
