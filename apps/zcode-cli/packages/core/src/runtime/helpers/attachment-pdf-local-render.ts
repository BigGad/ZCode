import type {
  FilePartSource,
  ImageProcessorPort,
  ModelInputFormat,
  PdfDocumentPort,
  TraceContext,
  TurnAttachment,
  WorkspaceResourceIndexPort,
} from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE } from "../types.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import {
  buildPdfPageImageBlocks,
  canRenderPdfPageImages,
  renderPdfPageImages,
} from "./attachment-pdf-pages.js";
import { upsertAttachmentToResourceIndex } from "./attachment-resource-index.js";

export interface LocalPdfPageRenderInput {
  attachment: TurnAttachment;
  absolutePath: string;
  filename: string;
  index: number;
  mime: string;
  sizeBytes: number;
  source: FilePartSource;
  options: {
    abortSignal?: AbortSignal;
    imageProcessorPort?: ImageProcessorPort;
    modelInputFormat?: ModelInputFormat;
    pdfDocumentPort?: PdfDocumentPort;
    traceContext: TraceContext;
    workspaceKey?: string;
    workspaceResourceIndexPort?: WorkspaceResourceIndexPort;
  };
}

/**
 * 本地 PDF 页图渲染（见 message-attachments.md 分发矩阵）：
 * - 密码 PDF → 占位符 errorCode（密码问询由 pdfDocumentPort 装饰器统一处理）；
 * - 其他渲染失败（Poppler 缺失 / io_error 等）→ 返回 undefined，由调用方
 *   回退 file block，优雅降级不终止 turn。
 * 渲染成功时在本文件内完成 resource index upsert（与 local-media-resolver
 * 的 finalizeLocal 语义一致：storageKind local_ref、原始路径引用）。
 */
export async function renderLocalPdfPageImages(
  input: LocalPdfPageRenderInput,
): Promise<ResolvedTurnAttachment | undefined> {
  const { attachment, absolutePath, filename, index, mime, options, sizeBytes, source } = input;
  if (!canRenderPdfPageImages(options)) return undefined;
  const render = await renderPdfPageImages({
    abortSignal: options.abortSignal,
    filePath: absolutePath,
    imageProcessorPort: options.imageProcessorPort!,
    pdfDocumentPort: options.pdfDocumentPort!,
    traceContext: options.traceContext,
  });
  if (render.kind === "password_protected") {
    return resolvedPlaceholderAttachment(
      attachment,
      attachment.path!,
      PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE,
      { filename, mime, sizeBytes, source },
    );
  }
  if (render.kind === "render_unavailable") return undefined;
  const { blocks, pdfMetadata } = buildPdfPageImageBlocks(render, {
    attachmentIndex: index,
    filename,
    sourcePath: absolutePath,
  });
  if (options.workspaceKey && options.workspaceResourceIndexPort) {
    upsertAttachmentToResourceIndex(options.workspaceResourceIndexPort, attachment, {
      workspaceKey: options.workspaceKey,
      sourceOrigin: "user_upload",
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      mime,
      bytes: sizeBytes,
      path: absolutePath,
    });
  }
  return {
    contentBlock: {
      type: "file",
      mediaType: mime,
      name: filename,
      // 页图形态下原始 file block 不投递；保留为单块回退数据与冷恢复 artifact 引用。
      dataUrl: "",
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "local_file",
        mimeType: mime,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes,
      },
    },
    contentBlocks: blocks,
    filename,
    metadata: {
      originalUrl: attachment.path,
      pdf: pdfMetadata,
      recoverability: "rebuildable",
      sizeBytes,
      storageKind: "local_ref",
    },
    mime,
    source,
    url: attachment.path!,
  };
}
