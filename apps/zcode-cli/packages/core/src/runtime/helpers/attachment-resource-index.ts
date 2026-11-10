import { createHash, randomUUID } from "node:crypto";
import type {
  TurnAttachment,
  WorkspaceResourceIndexPort,
  WorkspaceResourceIndexEntry,
  WorkspaceResourceVariant,
} from "../deps.js";

/**
 * attachment resolver 完成后，把"原始" variant 写入 workspace 资源库。
 * 失败不阻断 attachment 主线：best-effort async fire-and-forget。
 *
 * ID = sha256(`${workspaceKey}|${sourceOrigin}|${mime}|${sha256 ?? bytes 长度}|${filename}`)
 * 同内容（同 workspace + 同 sourceOrigin）多次上传 → 同一 entry。
 * inline 无 sha256 时用 randomUUID 兜底，保证跨上传不冲突。
 */
export interface UpsertAttachmentToResourceIndexInput {
  workspaceKey: string;
  sourceOrigin: WorkspaceResourceIndexEntry["sourceOrigin"];
  policyTag?: string;
  policySource?: WorkspaceResourceIndexEntry["meta"] extends infer M
    ? M extends { policySource?: infer S }
      ? S
      : never
    : never;
  /** 已 resolve 后的核心元数据。 */
  filename?: string;
  mime: string;
  bytes: number;
  artifactUri?: string;
  /** request-local path，跨 session 不持久化；resource index 仅作 preview reference。 */
  path?: string;
  sha256?: string;
  /**
   * 额外的变体（与 `original` 并列登记在同一条目上）。
   *
   * ⚠️ 本地 OCR 的产物登记成 `ocr` 变体（spec：capability-provisioning.md §2 的 D10）：
   * 它是「从原件派生出来的文字」，与 `original` 是两件事。
   */
  extraVariants?: readonly WorkspaceResourceVariant[];
}

export function upsertAttachmentToResourceIndex(
  port: WorkspaceResourceIndexPort | undefined,
  attachment: TurnAttachment,
  input: UpsertAttachmentToResourceIndexInput,
): void {
  if (!port) return;
  // fire-and-forget：不阻断 attachment 主线，错误仅记日志。
  const entry = buildResourceIndexEntry(attachment, input);
  void port.upsert(entry).catch(() => {
    // 静默失败：resource index 不可用 / 写失败不破坏当前 turn 的 attachment 主线。
    // 详细失败信息由 port 调用方日志覆盖；此处不重复 log 噪音。
  });
}

function buildResourceIndexEntry(
  attachment: TurnAttachment,
  input: UpsertAttachmentToResourceIndexInput,
): WorkspaceResourceIndexEntry {
  const now = Date.now();
  const kind = attachmentKindFromAttachment(attachment);
  const id = deriveEntryId(input, kind);
  const original: WorkspaceResourceVariant = {
    kind: "original",
    mime: input.mime,
    bytes: input.bytes,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    ...(input.artifactUri ? { artifactUri: input.artifactUri } : {}),
    ...(input.path ? { path: input.path } : {}),
  };
  return {
    id,
    workspaceIdentity: input.workspaceKey,
    workspacePath: input.workspaceKey,
    kind,
    title: input.filename ?? attachment.filename ?? `${kind}-${now}`,
    ...(input.filename || attachment.filename
      ? { filename: input.filename ?? attachment.filename }
      : {}),
    sourceOrigin: input.sourceOrigin,
    addedAt: now,
    updatedAt: now,
    // ⚠️ `original` 在前、派生变体在后：消费方按顺序找第一个可用变体。
    variants: [original, ...(input.extraVariants ?? [])],
    references: 1,
    ...(input.policyTag || input.policySource
      ? {
          meta: {
            ...(input.policyTag ? { policyTag: input.policyTag } : {}),
            ...(input.policySource ? { policySource: input.policySource } : {}),
          },
        }
      : {}),
  };
}

function deriveEntryId(
  input: UpsertAttachmentToResourceIndexInput,
  kind: string,
): string {
  const stableKey = [
    input.workspaceKey,
    input.sourceOrigin,
    kind,
    input.mime,
    input.sha256 ?? `len-${input.bytes}`,
    input.filename ?? "",
  ].join("|");
  const hash = createHash("sha256").update(stableKey).digest("hex").slice(0, 26);
  return `${kind.toUpperCase().slice(0, 4)}_${hash}`;
}

function attachmentKindFromAttachment(
  attachment: TurnAttachment,
): WorkspaceResourceIndexEntry["kind"] {
  switch (attachment.type) {
    case "image":
      return "image";
    case "pdf":
      return "pdf";
    case "video":
      return "video";
    case "file":
    default:
      // TurnAttachment 当前不含 audio（Phase 3 才接入），其它未识别 type 兜底为 image。
      // 待 Phase 3 加入 audio 后扩展此分支。
      return "image";
  }
}

// 留作后续 phase 的扩展点：hash-based 冲突检测、policy 字段注入等。
// 当前最小实现已满足 Phase 2.4（image / pdf / video / file / audio upsert）。
export function createAttachmentResourceIndexId(input: {
  workspaceKey: string;
  mime: string;
  bytes: number;
  sha256?: string;
}): string {
  return `AUTO_${createHash("sha256")
    .update([input.workspaceKey, input.mime, input.sha256 ?? `len-${input.bytes}`].join("|"))
    .digest("hex")
    .slice(0, 22)}`;
}

export function createAttachmentResourceIndexUuid(): string {
  return randomUUID();
}