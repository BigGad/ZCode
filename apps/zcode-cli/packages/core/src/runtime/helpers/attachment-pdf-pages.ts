import {
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_MAX_DIMENSION,
  READ_IMAGE_TARGET_BYTES,
  READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
  READ_MAX_OUTPUT_TOKENS,
  READ_PDF_MAX_PAGES_PER_REQUEST,
  PdfDocumentPortError,
} from "@zcode/contracts";
import type {
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import type { ImageProcessorPort, PdfDocumentPort } from "../deps.js";
import type { ModelInputFormat } from "../deps.js";
import type { AttachmentStorageMetadata } from "../deps.js";

// 页图子预算：请求级 media budget 为 40MiB（media-budget.ts），单个 PDF 附件封顶
// 12MiB，避免 protected latest-user-message 在多附件场景下触发硬错误。
export const PDF_ATTACHMENT_PAGE_IMAGES_BUDGET_BYTES = 12 * 1024 * 1024;
// 与 read 工具 READ_PDF_MAX_PAGES_PER_REQUEST 同值；超出部分由 agent 用 Read+pages 续读。
export const PDF_ATTACHMENT_MAX_RENDERED_PAGES = READ_PDF_MAX_PAGES_PER_REQUEST;

const PDF_PAGE_IMAGE_SOURCE_ID_PREFIX = "turn-attachment";

export type PdfPageImageRenderFailure =
  | { kind: "password_protected" }
  | { kind: "render_unavailable"; message: string };

export interface PreparedPdfPageImage {
  pageNumber: number;
  mediaType: string;
  dataUrl: string;
  sizeBytes: number;
}

export interface PdfPageImageRenderResult {
  kind: "rendered";
  pageCount?: number;
  renderedPages: PreparedPdfPageImage[];
}

export interface PdfPageImagesCapability {
  modelInputFormat?: ModelInputFormat;
  pdfDocumentPort?: PdfDocumentPort;
  imageProcessorPort?: ImageProcessorPort;
}

export interface PdfPageImageRenderContext {
  filePath: string;
  traceContext: TraceContext;
  abortSignal?: AbortSignal;
  pdfDocumentPort: PdfDocumentPort;
  imageProcessorPort: ImageProcessorPort;
  /** 仅内存传递给 port，禁止写入事件/元数据/日志（见 message-attachments.md 密码节）。 */
  password?: string;
}

export interface PdfPageImageBlockInfo {
  attachmentIndex: number;
  filename: string;
  sourcePath: string;
}

/**
 * 页图渲染门槛：页图本质是 image blocks，因此只看 supportsImage；
 * supportsPdf=false 但有视觉能力的模型同样受益（见 spec 分发矩阵）。
 */
export function canRenderPdfPageImages(capability: PdfPageImagesCapability): boolean {
  return (
    capability.modelInputFormat?.supportsImage === true &&
    capability.pdfDocumentPort !== undefined &&
    capability.imageProcessorPort !== undefined
  );
}

/**
 * 渲染 PDF 页图为待投递 image 素材：前 N 页（页数与字节双封顶）。
 * password_protected 单独归类供解锁流程识别；其余失败统一为 render_unavailable，
 * 由调用方回退 file block（优雅降级，不得终止 turn）。
 */
export async function renderPdfPageImages(
  context: PdfPageImageRenderContext,
): Promise<PdfPageImageRenderResult | PdfPageImageRenderFailure> {
  const { pdfDocumentPort, imageProcessorPort } = context;
  try {
    const pageCount = await pdfDocumentPort.getPageCount(
      { filePath: context.filePath, password: context.password, trace: context.traceContext },
      { signal: context.abortSignal },
    );
    if (pageCount === undefined) {
      return {
        kind: "render_unavailable",
        message: `PDF page count unavailable: ${context.filePath}`,
      };
    }
    const lastPage = Math.min(pageCount, PDF_ATTACHMENT_MAX_RENDERED_PAGES);
    if (lastPage < 1) {
      return { kind: "render_unavailable", message: `PDF has no pages: ${context.filePath}` };
    }
    const renderedPages = await pdfDocumentPort.renderPages(
      {
        filePath: context.filePath,
        firstPage: 1,
        lastPage,
        password: context.password,
        trace: context.traceContext,
      },
      { signal: context.abortSignal },
    );
    let budgetBytes = 0;
    const prepared: PreparedPdfPageImage[] = [];
    for (const page of renderedPages) {
      const preparedPage = await imageProcessorPort.prepareForModel(
        {
          data: page.data,
          maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
          maxDimension: READ_IMAGE_MAX_DIMENSION,
          maxRawBytes: READ_IMAGE_TARGET_BYTES,
          maxTokens: READ_MAX_OUTPUT_TOKENS,
          mediaType: page.mediaType,
          tokenToBase64CharRatio: READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
          trace: context.traceContext,
        },
        { signal: context.abortSignal },
      );
      const base64 = Buffer.from(preparedPage.data).toString("base64");
      const sizeBytes = base64.length;
      // 超预算即止：已渲染页有效，剩余页经尾注引导 agent 用 Read+pages 续读。
      if (budgetBytes + sizeBytes > PDF_ATTACHMENT_PAGE_IMAGES_BUDGET_BYTES) break;
      budgetBytes += sizeBytes;
      prepared.push({
        pageNumber: page.pageNumber,
        mediaType: preparedPage.mediaType,
        dataUrl: `data:${preparedPage.mediaType};base64,${base64}`,
        sizeBytes,
      });
    }
    prepared.sort((left, right) => left.pageNumber - right.pageNumber);
    return { kind: "rendered", pageCount, renderedPages: prepared };
  } catch (error) {
    if (error instanceof PdfDocumentPortError) {
      if (error.code === "password_protected") return { kind: "password_protected" };
      if (error.code === "cancelled") throw error;
      return { kind: "render_unavailable", message: error.message };
    }
    throw error;
  }
}

/**
 * 把渲染结果组装为可投递内容块：每页一个 image block + 尾注 text block
 * （总页数/已投页数/源路径，供 Read+pages 续读与冷恢复）。
 */
export function buildPdfPageImageBlocks(
  result: PdfPageImageRenderResult,
  info: PdfPageImageBlockInfo,
): { blocks: ModelMessageContentBlock[]; pdfMetadata: NonNullable<AttachmentStorageMetadata["pdf"]> } {
  const renderedCount = result.renderedPages.length;
  const blocks: ModelMessageContentBlock[] = result.renderedPages.map((page) => ({
    type: "image",
    mediaType: page.mediaType,
    dataUrl: page.dataUrl,
    source: {
      id: `${PDF_PAGE_IMAGE_SOURCE_ID_PREFIX}-${info.attachmentIndex + 1}-page-${page.pageNumber}`,
      kind: "inline",
      mimeType: page.mediaType,
      placeholder: `${info.filename} page ${page.pageNumber}`,
      sizeBytes: page.sizeBytes,
    },
  }));
  blocks.push({ type: "text", text: buildTrailerText(result, info) });
  return {
    blocks,
    pdfMetadata: {
      pageCount: result.pageCount,
      renderedPageCount: renderedCount,
      renderStrategy: "page_images",
    },
  };
}

function buildTrailerText(result: PdfPageImageRenderResult, info: PdfPageImageBlockInfo): string {
  const renderedCount = result.renderedPages.length;
  const head = `PDF attachment "${info.filename}" (${info.sourcePath}) has ${result.pageCount ?? "unknown"} total page(s).`;
  if (result.pageCount !== undefined && renderedCount >= result.pageCount) {
    return `${head} All pages are attached as page images above.`;
  }
  return [
    head,
    `Only the first ${renderedCount} page(s) are attached as page images (page/size budget).`,
    `To read further pages, use the Read tool on "${info.sourcePath}" with the pages parameter (e.g. pages: "${renderedCount + 1}-${Math.min((result.pageCount ?? renderedCount + 20), renderedCount + 20)}").`,
  ].join(" ");
}
