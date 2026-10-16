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
}
