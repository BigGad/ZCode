import { VIDEO_INPUT_MAX_BYTES } from "@zcode/contracts";
import { basename, isFileSystemPortError, resolvePath } from "../deps.js";
import type {
  FilePartSource,
  FileSystemPort,
  TurnAttachment,
} from "../deps.js";
import { INLINE_MEDIA_ATTACHMENT_MAX_BYTES } from "../types.js";
import type { PreparedImageData, ResolvedTurnAttachment } from "../types.js";
import { persistAttachmentDataUrl } from "./attachment-artifacts.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { inferImageMimeFromPath, prepareImageDataUrl } from "./attachment-image.js";
import { inferVideoMimeFromPath } from "./attachment-video.js";
import { isPdfBytes, PDF_INPUT_MAX_BYTES } from "./attachment-pdf.js";
import { renderLocalPdfPageImages } from "./attachment-pdf-local-render.js";
import { resolvedPathReferenceAttachment } from "./attachment-path-reference.js";
import { upsertAttachmentToResourceIndex } from "./attachment-resource-index.js";
import {
  buildLocalOcrFailureText,
  buildLocalOcrText,
  decideProvisioning,
  provisionLocalOcr,
} from "./capability-provisioning/index.js";
import type { LocalInfraProvisioning } from "./capability-provisioning/index.js";
import type { InlineMediaResolverOptions } from "./inline-media-resolver.js";

export interface LocalMediaResolverOptions extends Omit<
  InlineMediaResolverOptions,
  "existingArtifactUri"
> {
  fileSystemPort: FileSystemPort;
  /** 能力供给层（本地 OCR）；缺席即不做供给，附件走既有路线。 */
  localInfra?: LocalInfraProvisioning;
  workingDirectory: string;
}

interface LocalMediaContext {
  absolutePath: string;
  attachment: TurnAttachment;
  filename: string;
  index: number;
  mime: string;
  options: LocalMediaResolverOptions;
  source: FilePartSource;
  stat: Awaited<ReturnType<FileSystemPort["stat"]>>;
}

export async function resolveLocalMediaAttachment(
  attachment: TurnAttachment,
  index: number,
  options: LocalMediaResolverOptions,
): Promise<ResolvedTurnAttachment> {
  const attachmentPath = attachment.path!;
  const absolutePath = resolvePath(options.workingDirectory, attachmentPath);
  const filename = basename(absolutePath);
  const mime =
    attachment.type === "image"
      ? inferImageMimeFromPath(absolutePath)
      : attachment.type === "pdf"
        ? "application/pdf"
        : (inferVideoMimeFromPath(absolutePath) ?? attachment.mimeType ?? "video/mp4");
  const source: FilePartSource = {
    type: "file",
    path: absolutePath,
    text: { value: attachmentPath, start: 0, end: attachmentPath.length },
  };
  let stat: Awaited<ReturnType<FileSystemPort["stat"]>>;
  try {
    stat = await options.fileSystemPort.stat(
      { path: absolutePath, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch {
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  if (stat.kind !== "file") {
    return resolvedPlaceholderAttachment(attachment, attachmentPath, "attachment_not_file", {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
    });
  }

  const context: LocalMediaContext = {
    absolutePath,
    attachment,
    filename,
    index,
    mime,
    options,
    source,
    stat,
  };
  if (attachment.type === "image") return resolveLocalImageAttachment(context);
  if (attachment.type === "pdf") return resolveLocalPdfAttachment(context);
  return resolveLocalVideoAttachment(context);
}

async function resolveLocalPdfAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, mime, options, source, stat } = context;
  if (stat.sizeBytes > PDF_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "pdf_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readBinaryFile"]>>;
  try {
    read = await options.fileSystemPort.readBinaryFile(
      { path: absolutePath, maxBytes: PDF_INPUT_MAX_BYTES, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        source,
        reason: "pdf_too_large",
      });
    }
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  if (read.bytesRead === 0 || !isPdfBytes(read.content)) {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_pdf_invalid", {
      filename,
      mime,
      sizeBytes: read.sizeBytes,
      source,
    });
  }
  const dataUrl = `data:${mime};base64,${Buffer.from(read.content).toString("base64")}`;
  const resource = await persistAttachmentDataUrl(dataUrl, context.index, mime, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  const fileBlockResult = () =>
    finalizeLocal(attachment, options, {
      contentBlock: {
        type: "file",
        mediaType: mime,
        name: filename,
        dataUrl,
        source: {
          id: `turn-attachment-${context.index + 1}`,
          kind: "local_file",
          mimeType: mime,
          path: absolutePath,
          placeholder: attachment.path,
          sizeBytes: read.sizeBytes,
          sha256: read.revision?.hash,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      filename,
      metadata: {
        originalUrl: attachment.path,
        recoverability: resource.metadata.recoverability,
        sha256: read.revision?.hash,
        sizeBytes: read.sizeBytes,
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime,
      source,
      url: resource.url,
    }, { absolutePath, sha256: read.revision?.hash });
  const rendered = await renderLocalPdfPageImages({
    absolutePath,
    attachment,
    filename,
    index: context.index,
    mime,
    options,
    sizeBytes: read.sizeBytes,
    source,
  });
  if (rendered) return rendered;
  // ⚠️ 本地 OCR 分支（spec：capability-provisioning.md §8.3）：
  // 插在「页图渲染不可用」与「回落 file block」之间 —— 前两条路都不通时才考虑本地引擎。
  // 判定不委派（模型能力位未知 / 端口未装配）⇒ 返回 undefined，走既有 file block 路线。
  const ocr = await resolveLocalPdfByOcr(context, read.sizeBytes, read.revision?.hash);
  if (ocr) return ocr;
  return fileBlockResult();
}

/**
 * 本地 OCR 路线（spec §7.2 第 6/7/8/9 行 + §11 行）。
 *
 * ⚠️ **返回 undefined = 不委派**（走既有路线）；返回附件 = 本地 OCR 的结果或明确的错误文本。
 */
async function resolveLocalPdfByOcr(
  context: LocalMediaContext,
  sizeBytes: number,
  sha256: string | undefined,
): Promise<ResolvedTurnAttachment | undefined> {
  const { absolutePath, filename, options } = context;
  const localInfra = options.localInfra;
  if (localInfra === undefined) return undefined;

  const decision = await decideProvisioning({
    attachmentKind: "pdf",
    ...(options.modelInputFormat !== undefined
      ? { modelInputFormat: options.modelInputFormat }
      : {}),
    degradation: localInfra.degradation,
    resolveReadiness: localInfra.resolveReadiness,
  });
  if (decision.route === "existing") return undefined;

  if (decision.route === "error") {
    // 明确报错：缺哪一层 + 确定的下一步（装法 / 下载命令），不静默失败、不静默换路。
    const text = buildLocalOcrFailureText({ filename, decision });
    return resolvedOcrTextAttachment(context, {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    });
  }

  // 本地引擎路线：产物必须落**会话级 artifact 目录**（D9），不得落在用户源文件旁。
  const outputDir = await resolveOcrOutputDir(options, context.index, sha256);
  if (outputDir === undefined) {
    const failureDecision = {
      ...decision,
      route: "error" as const,
      ruleId: "rule-9" as const,
      reason: "无法解析会话级产物目录，本地 OCR 产物无处落盘。",
    };
    const text = buildLocalOcrFailureText({ filename, decision: failureDecision });
    return resolvedOcrTextAttachment(context, {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    });
  }

  const outcome = await provisionLocalOcr({
    absolutePath,
    outputDir,
    ...(decision.readiness?.tier !== undefined ? { tier: decision.readiness.tier } : {}),
    localInfraPort: localInfra.port,
    fileSystemPort: options.fileSystemPort,
    traceContext: options.traceContext,
    ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
  });

  if (!outcome.ok) {
    const text = buildLocalOcrFailureText({ filename, decision, failure: outcome });
    return resolvedOcrTextAttachment(context, {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    });
  }

  registerOcrVariant(context, {
    bytes: outcome.bytes,
    markdownPath: outcome.markdownPath,
    sizeBytes,
    sha256,
  });

  const text = buildLocalOcrText({
    filename,
    markdown: outcome.markdown,
    ...(outcome.tier !== undefined ? { tier: outcome.tier } : {}),
  });
  return resolvedOcrTextAttachment(context, {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
  });
}

/**
 * 解析本地 OCR 的产物目录。
 *
 * ⚠️ **目录布局由 artifact store 拥有**（`resolveSessionArtifactDir`）——
 * 业务层不重算 `<storageRoot>/cli/artifacts/<sessionId>/`。
 * ⚠️ 拿不到目录 ⇒ **放弃这条路**，绝不退回「源文件旁」（D9）。
 */
async function resolveOcrOutputDir(
  options: LocalMediaResolverOptions,
  index: number,
  sha256: string | undefined,
): Promise<string | undefined> {
  const resolveDir = options.artifactStore?.resolveSessionArtifactDir?.bind(options.artifactStore);
  if (resolveDir === undefined || options.sessionId === undefined) return undefined;
  try {
    const resolved = await resolveDir({
      sessionId: options.sessionId,
      subdir: ocrOutputSubdir(index, sha256),
    });
    return resolved?.path;
  } catch {
    return undefined;
  }
}

/**
 * OCR 产物目录名。
 *
 * ⚠️ **必须带内容指纹，不能只有附件下标**：下标只在**同一轮任务内**唯一。
 * 同一会话的另一轮任务里，下标会重复（都是 0），文档却可能不同 ——
 * 而引擎的 `prepareOutputDir` 是**先删再建**（local-infra §6.2）⇒ 共用目录会把
 * 上一轮的产物**清空覆盖**，资源索引里已登记的 `ocr` 变体路径就指向了别人的内容。
 *
 * ⚠️ **用内容指纹而不是随机数**：同一份文档重复解析落在同一个目录，
 * 产物天然幂等（引擎重写出同样的内容）；拿不到指纹时才退回随机后缀。
 */
function ocrOutputSubdir(index: number, sha256: string | undefined): string {
  const fingerprint = sha256?.replace(/^sha256:/u, "").slice(0, 16);
  const token =
    fingerprint !== undefined && fingerprint.length > 0 ? fingerprint : crypto.randomUUID();
  return `ocr-${index}-${token}`;
}

/**
 * 本地 OCR 的文本附件（成功与失败都是「一段文字」形态）。
 *
 * ⚠️ **`bytes` 是「投递出去的内联文本」的字节数**（含前缀说明行），不是原始 PDF 的字节数，
 * 也不是产物 markdown 文件的字节数 —— 产物文件的大小记在资源索引的 `ocr` 变体上。
 */
function resolvedOcrTextAttachment(
  context: LocalMediaContext,
  input: { readonly text: string; readonly bytes: number },
): ResolvedTurnAttachment {
  const { attachment, filename, source } = context;
  return {
    contentBlock: { type: "text", text: input.text },
    filename,
    metadata: {
      originalUrl: attachment.path,
      preview: {
        text: input.text,
        truncated: false,
        originalBytes: input.bytes,
      },
      recoverability: "provider_ready",
      sizeBytes: input.bytes,
      storageKind: "inline",
    },
    mime: "text/markdown",
    source,
    url: attachment.path ?? filename,
  };
}

/** 把 OCR 产物登记成资源索引里的 `ocr` 变体（D10）。 */
function registerOcrVariant(
  context: LocalMediaContext,
  input: {
    readonly bytes: number;
    readonly markdownPath: string;
    readonly sizeBytes: number;
    readonly sha256?: string;
  },
): void {
  const { absolutePath, attachment, options } = context;
  if (!options.workspaceKey || !options.workspaceResourceIndexPort) return;
  upsertAttachmentToResourceIndex(options.workspaceResourceIndexPort, attachment, {
    workspaceKey: options.workspaceKey,
    sourceOrigin: "user_upload",
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    mime: "application/pdf",
    bytes: input.sizeBytes,
    path: absolutePath,
    ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
    extraVariants: [
      {
        kind: "ocr",
        mime: "text/markdown",
        bytes: input.bytes,
        path: input.markdownPath,
      },
    ],
  });
}

async function resolveLocalImageAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, index, mime, options, source, stat } = context;
  if (stat.sizeBytes > INLINE_MEDIA_ATTACHMENT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "image_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readTextFile"]>>;
  try {
    read = await options.fileSystemPort.readTextFile(
      { path: absolutePath, encoding: "base64", trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch {
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  const dataUrl = `data:${mime};base64,${read.content}`;
  let prepared: PreparedImageData | undefined;
  try {
    prepared = await prepareImageDataUrl(dataUrl, mime, options);
  } catch {
    return resolvedPlaceholderAttachment(
      attachment,
      attachment.path!,
      "attachment_image_resize_failed",
      { filename, mime, sizeBytes: stat.sizeBytes, source },
    );
  }
  if (!prepared) {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_image_invalid", {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
    });
  }
  const resource = await persistAttachmentDataUrl(prepared.dataUrl, index, prepared.mediaType, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return finalizeLocal(attachment, options, {
    contentBlock: {
      type: "image",
      mediaType: prepared.mediaType,
      dataUrl: prepared.dataUrl,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "local_file",
        mimeType: prepared.mediaType,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes: stat.sizeBytes,
        sha256: read.revision?.hash,
      },
    },
    filename,
    metadata: {
      ...(prepared.metadata ? { image: prepared.metadata } : {}),
      originalUrl: attachment.path,
      recoverability: resource.metadata.recoverability,
      sha256: read.revision?.hash,
      sizeBytes: read.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime: prepared.mediaType,
    source,
    url: resource.url,
  }, { absolutePath, sha256: read.revision?.hash });
}

async function resolveLocalVideoAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, index, mime, options, source, stat } = context;
  if (stat.sizeBytes > VIDEO_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "video_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readBinaryFile"]>>;
  try {
    read = await options.fileSystemPort.readBinaryFile(
      { path: absolutePath, maxBytes: VIDEO_INPUT_MAX_BYTES, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      // 外层 stat 后文件仍可能增长；以读取端的 maxBytes 结果为最终边界。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        source,
        reason: "video_too_large",
      });
    }
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  // 文件可能在 stat 后被清空，必须以实际读取结果判断是否为有效视频。
  if (read.bytesRead === 0) {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_video_invalid", {
      filename,
      mime,
      sizeBytes: read.sizeBytes,
      source,
    });
  }
  const dataUrl = `data:${mime};base64,${Buffer.from(read.content).toString("base64")}`;
  const resource = await persistAttachmentDataUrl(dataUrl, index, mime, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return finalizeLocal(attachment, options, {
    contentBlock: {
      type: "video",
      mediaType: mime,
      dataUrl,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "local_file",
        mimeType: mime,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes: read.sizeBytes,
        sha256: read.revision?.hash,
      },
    },
    filename,
    metadata: {
      originalUrl: attachment.path,
      recoverability: resource.metadata.recoverability,
      sha256: read.revision?.hash,
      sizeBytes: read.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime,
    source,
    url: resource.url,
  }, { absolutePath, sha256: read.revision?.hash });
}

function localMediaReadFailure(
  attachment: TurnAttachment,
  filename: string,
  mime: string,
  source: FilePartSource,
): ResolvedTurnAttachment {
  return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_read_failed", {
    filename,
    mime,
    source,
  });
}

function finalizeLocal(
  attachment: TurnAttachment,
  options: LocalMediaResolverOptions,
  resolved: ResolvedTurnAttachment,
  context: { absolutePath: string; sha256?: string },
): ResolvedTurnAttachment {
  if (!options.workspaceKey || !options.workspaceResourceIndexPort) return resolved;
  upsertAttachmentToResourceIndex(options.workspaceResourceIndexPort, attachment, {
    workspaceKey: options.workspaceKey,
    sourceOrigin: "user_upload",
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    mime: resolved.mime,
    bytes: resolved.metadata.sizeBytes ?? 0,
    ...(resolved.metadata.artifactUri ? { artifactUri: resolved.metadata.artifactUri } : {}),
    path: context.absolutePath,
    ...(context.sha256 ? { sha256: context.sha256 } : {}),
  });
  return resolved;
}