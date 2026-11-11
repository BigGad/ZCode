import { VIDEO_INPUT_MAX_BYTES } from "@zcode/contracts";
import type {
  ImageProcessorPort,
  Logger,
  ModelInputFormat,
  PdfDocumentPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnId,
  WorkspaceResourceIndexPort,
} from "../deps.js";
import type { PreparedImageData, ResolvedTurnAttachment } from "../types.js";
import { PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE } from "../types.js";
import { persistAttachmentDataUrl } from "./attachment-artifacts.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { prepareImageDataUrl } from "./attachment-image.js";
import { parseInlineVideoDataUrl } from "./attachment-video.js";
import { parseInlinePdfDataUrl, PDF_INPUT_MAX_BYTES } from "./attachment-pdf.js";
import {
  buildPdfPageImageBlocks,
  canRenderPdfPageImages,
  renderPdfPageImages,
} from "./attachment-pdf-pages.js";
import { resolvedPathReferenceAttachment } from "./attachment-path-reference.js";
import { upsertAttachmentToResourceIndex } from "./attachment-resource-index.js";

export interface InlineMediaResolverOptions {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  existingArtifactUri?: string;
  imageProcessorPort?: ImageProcessorPort;
  modelInputFormat?: ModelInputFormat;
  pdfDocumentPort?: PdfDocumentPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
  workspaceKey?: string;
  workspaceResourceIndexPort?: WorkspaceResourceIndexPort;
  /**
   * 运行期日志（第 2 步的自动备资产要报「开始下载 / 下载完成」——
   * 权重 0.8–1.2GB，阻塞期间没有提示用户会以为卡死）。
   */
  logger?: Logger;
}

export async function resolveInlineMediaAttachment(
  attachment: TurnAttachment,
  index: number,
  parsedMediaType: string | undefined,
  options: InlineMediaResolverOptions,
): Promise<ResolvedTurnAttachment | undefined> {
  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  if (attachment.type === "image" && attachment.content && parsedMediaType?.startsWith("image/")) {
    let prepared: PreparedImageData | undefined;
    try {
      prepared = await prepareImageDataUrl(attachment.content, parsedMediaType, options);
    } catch {
      return resolvedPlaceholderAttachment(
        attachment,
        placeholder,
        "attachment_image_resize_failed",
      );
    }
    if (!prepared) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_image_invalid");
    }
    const resource = await persistAttachmentDataUrl(prepared.dataUrl, index, prepared.mediaType, {
      abortSignal: options.abortSignal,
      artifactStore: options.artifactStore,
      existingArtifactUri: options.existingArtifactUri,
      sessionId: options.sessionId,
      traceContext: options.traceContext,
      turnId: options.turnId,
    });
    return finalizeInline(attachment, options, {
      contentBlock: {
        type: "image",
        mediaType: prepared.mediaType,
        dataUrl: prepared.dataUrl,
        source: {
          id: `turn-attachment-${index + 1}`,
          kind: "inline",
          mimeType: options.existingArtifactUri ? parsedMediaType : prepared.mediaType,
          placeholder,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      metadata: {
        ...(prepared.metadata ? { image: prepared.metadata } : {}),
        recoverability: resource.metadata.recoverability,
        sizeBytes: Buffer.byteLength(attachment.content, "utf8"),
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime: prepared.mediaType,
      url: resource.url,
    });
  }

  if (attachment.type === "pdf" && attachment.content) {
    const pdfData = parseInlinePdfDataUrl(attachment.content);
    if (!pdfData) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_pdf_invalid", {
        filename: attachment.filename,
        mime: "application/pdf",
        sizeBytes: attachment.sizeBytes,
      });
    }
    if (pdfData.sizeBytes === 0 || pdfData.sizeBytes > PDF_INPUT_MAX_BYTES) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_pdf_invalid", {
        filename: attachment.filename,
        mime: "application/pdf",
        sizeBytes: pdfData.sizeBytes,
      });
    }
    const resource = await persistAttachmentDataUrl(attachment.content, index, pdfData.mediaType, {
      abortSignal: options.abortSignal,
      artifactStore: options.artifactStore,
      existingArtifactUri: options.existingArtifactUri,
      sessionId: options.sessionId,
      traceContext: options.traceContext,
      turnId: options.turnId,
    });
    const rendered = await renderInlinePdfPageImages(
      attachment,
      index,
      placeholder,
      pdfData,
      resource,
      options,
    );
    if (rendered) return rendered;
    return finalizeInline(attachment, options, {
      contentBlock: {
        type: "file",
        mediaType: pdfData.mediaType,
        name: attachment.filename,
        dataUrl: attachment.content,
        source: {
          id: `turn-attachment-${index + 1}`,
          kind: "inline",
          mimeType: pdfData.mediaType,
          placeholder,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      filename: attachment.filename,
      metadata: {
        recoverability: resource.metadata.recoverability,
        sizeBytes: pdfData.sizeBytes,
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime: pdfData.mediaType,
      url: resource.url,
    });
  }

  if (attachment.type !== "video" || !attachment.content) return undefined;

  const videoData = parseInlineVideoDataUrl(attachment.content);
  if (!videoData) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_video_invalid", {
      filename: attachment.filename,
      mime: attachment.mimeType ?? parsedMediaType ?? "video/*",
      sizeBytes: attachment.sizeBytes,
    });
  }
  // 空 payload 曾绕过视频大小校验并被持久化，导致实时与冷恢复消息形态不一致。
  if (videoData.sizeBytes === 0) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_video_invalid", {
      filename: attachment.filename,
      mime: videoData.mediaType,
      sizeBytes: videoData.sizeBytes,
    });
  }
  if (videoData.sizeBytes > VIDEO_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, placeholder, {
      filename: attachment.filename,
      mime: videoData.mediaType,
      sizeBytes: videoData.sizeBytes,
      reason: "video_too_large",
    });
  }
  const resource = await persistAttachmentDataUrl(attachment.content, index, videoData.mediaType, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    existingArtifactUri: options.existingArtifactUri,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return finalizeInline(attachment, options, {
    contentBlock: {
      type: "video",
      mediaType: videoData.mediaType,
      dataUrl: attachment.content,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "inline",
        mimeType: videoData.mediaType,
        placeholder,
        ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
      },
    },
    metadata: {
      recoverability: resource.metadata.recoverability,
      sizeBytes: videoData.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime: videoData.mediaType,
    url: resource.url,
  });
}

function upsertFromResolvedInline(
  attachment: TurnAttachment,
  options: InlineMediaResolverOptions,
  result: ResolvedTurnAttachment,
): void {
  if (!options.workspaceKey || !options.workspaceResourceIndexPort) return;
  upsertAttachmentToResourceIndex(options.workspaceResourceIndexPort, attachment, {
    workspaceKey: options.workspaceKey,
    sourceOrigin: "user_upload",
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    mime: result.mime,
    bytes: result.metadata.sizeBytes ?? 0,
    ...(result.metadata.artifactUri ? { artifactUri: result.metadata.artifactUri } : {}),
  });
}

function finalizeInline(
  attachment: TurnAttachment,
  options: InlineMediaResolverOptions,
  resolved: ResolvedTurnAttachment,
): ResolvedTurnAttachment {
  upsertFromResolvedInline(attachment, options, resolved);
  return resolved;
}

type PersistedPdfResource = {
  metadata: {
    artifactUri?: string;
    recoverability: "provider_ready";
    storageKind: "artifact" | "inline";
  };
  url: string;
};

/**
 * inline PDF 页图渲染：pdftoppm 需要文件路径，而 inline PDF 只有 dataUrl，
 * 因此先经 durable artifact 物化派生路径；不可物化则返回 undefined，
 * 由调用方回退现有 file block 行为（优雅降级）。
 */
async function renderInlinePdfPageImages(
  attachment: TurnAttachment,
  index: number,
  placeholder: string,
  pdfData: { mediaType: string; sizeBytes: number },
  resource: PersistedPdfResource,
  options: InlineMediaResolverOptions,
): Promise<ResolvedTurnAttachment | undefined> {
  if (!canRenderPdfPageImages(options)) return undefined;
  const artifactStore = options.artifactStore;
  if (!artifactStore?.ensureMediaAttachmentPath) return undefined;
  const uri = resource.metadata.artifactUri ?? resource.url;
  if (!uri.startsWith("zcode-artifact://")) return undefined;
  let renderedPath: string;
  try {
    const ensured = await artifactStore.ensureMediaAttachmentPath({
      mediaType: pdfData.mediaType,
      uri,
    });
    if (ensured.status !== "ready" || !ensured.path.trim()) return undefined;
    renderedPath = ensured.path;
  } catch {
    // 物化失败不阻断发送；回退 file block 保持与未启用渲染时一致的行为。
    return undefined;
  }
  const render = await renderPdfPageImages({
    abortSignal: options.abortSignal,
    filePath: renderedPath,
    imageProcessorPort: options.imageProcessorPort!,
    pdfDocumentPort: options.pdfDocumentPort!,
    traceContext: options.traceContext,
  });
  if (render.kind === "password_protected") {
    return resolvedPlaceholderAttachment(
      attachment,
      placeholder,
      PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE,
      {
        filename: attachment.filename,
        mime: pdfData.mediaType,
        sizeBytes: pdfData.sizeBytes,
      },
    );
  }
  if (render.kind === "render_unavailable") return undefined;
  const { blocks, pdfMetadata } = buildPdfPageImageBlocks(render, {
    attachmentIndex: index,
    filename: attachment.filename ?? placeholder,
    sourcePath: renderedPath,
  });
  return finalizeInline(attachment, options, {
    contentBlock: {
      type: "file",
      mediaType: pdfData.mediaType,
      name: attachment.filename,
      dataUrl: attachment.content,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "inline",
        mimeType: pdfData.mediaType,
        placeholder,
        ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
      },
    },
    contentBlocks: blocks,
    filename: attachment.filename,
    metadata: {
      pdf: pdfMetadata,
      recoverability: resource.metadata.recoverability,
      sizeBytes: pdfData.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime: pdfData.mediaType,
    url: resource.url,
  });
}