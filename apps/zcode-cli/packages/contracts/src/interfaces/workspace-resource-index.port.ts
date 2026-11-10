import type { TraceContext } from "../tracing/tracer.js";

/**
 * Workspace Resource Index 是 workspace 维度的跨 session 持久资源库。
 * 与 session-scoped FilePart 不同；同一 entry 跨 session 共享。
 * key 一律为 `workspaceIdentity?.trim() || workspacePath`。
 */
export type WorkspaceResourceKind =
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "stream"
  | "hardware"
  | "transcript"
  | "frame";

export interface WorkspaceResourceVariant {
  /**
   * 变体种类（闭集）。
   *
   * ⚠️ `ocr` 是**本地 OCR 的产物变体**（spec：capability-provisioning.md §2 的 D10）：
   * OCR 产物是「从 PDF 派生出来的文字」，既不是原始文件（`original`）也不是转写（`transcript`），
   * 复用会让人分不清「这个条目是原件还是解析结果」。
   */
  kind: "original" | "transcript" | "frame" | "thumbnail" | "waveform" | "ocr";
  mime: string;
  bytes: number;
  sha256?: string;
  /** durable artifact URI，格式 `zcode-artifact://<id>`。 */
  artifactUri?: string;
  /** request-local preview / 读取路径；不持久化跨 session。 */
  path?: string;
  meta?: Record<string, unknown>;
}

export type WorkspaceResourceSourceOrigin =
  | "user_upload"
  | "bot_attachment"
  | "tool_result"
  | "screen_capture"
  | "recording"
  | "device_stream"
  | "generated_output";

export interface WorkspaceResourceIndexEntry {
  id: string;
  workspaceIdentity: string;
  workspacePath: string;
  kind: WorkspaceResourceKind;
  title: string;
  filename?: string;
  sourceOrigin: WorkspaceResourceSourceOrigin;
  addedAt: number;
  updatedAt: number;
  lastReferencedAt?: number;
  variants: WorkspaceResourceVariant[];
  references: number;
  tags?: string[];
  meta?: {
    durationMs?: number;
    pageCount?: number;
    width?: number;
    height?: number;
    sampleRate?: number;
    channels?: number;
    policyTag?: string;
    policySource?: "explicit" | "auto-detected" | "default";
    transcriptStatus?: "pending" | "ready" | "failed";
    frameSamplingStatus?: "pending" | "ready" | "failed";
  };
}

export interface WorkspaceResourceIndexQuery {
  workspaceKey: string;
  kinds?: WorkspaceResourceKind[];
  tags?: string[];
  /** 命中 title / filename / tags 的子串搜索（大小写不敏感）。 */
  textSearch?: string;
  limit?: number;
  cursor?: string;
}

export interface WorkspaceResourceIndexQueryResult {
  entries: WorkspaceResourceIndexEntry[];
  nextCursor?: string;
}

export type WorkspaceResourceIndexErrorCode =
  | "resource_index_corrupt"
  | "resource_index_storage_full"
  | "resource_index_write_conflict"
  | "resource_not_found"
  | "workspace_key_invalid";

export class WorkspaceResourceIndexPortError extends Error {
  constructor(
    readonly code: WorkspaceResourceIndexErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceResourceIndexPortError";
  }
}

export interface WorkspaceResourceIndexPort {
  upsert(
    entry: WorkspaceResourceIndexEntry,
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<WorkspaceResourceIndexEntry>;
  getById(
    workspaceKey: string,
    id: string,
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<WorkspaceResourceIndexEntry | undefined>;
  query(
    req: WorkspaceResourceIndexQuery,
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<WorkspaceResourceIndexQueryResult>;
  addVariant(
    req: {
      workspaceKey: string;
      id: string;
      variant: WorkspaceResourceVariant;
    },
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<WorkspaceResourceIndexEntry>;
  incrementReferences(
    req: { workspaceKey: string; ids: string[]; delta: number },
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<void>;
  removeIfNotOrphaned(
    req: { workspaceKey: string; ids: string[] },
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<{ removed: string[] }>;
}