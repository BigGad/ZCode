import type { TraceContext } from "../tracing/tracer.js";

/** live capture 来源；`network-stream` 为 2026-10-16 增补（网络流采集，方案待重做）。 */
export type LiveCaptureSource =
  | "mic"
  | "camera"
  | "screen"
  | "system-audio"
  | "app-window"
  | "network-stream";

export interface LiveCaptureConstraints {
  video?: {
    width?: { min?: number; ideal?: number; max?: number };
    height?: { min?: number; ideal?: number; max?: number };
    frameRate?: { min?: number; ideal?: number; max?: number };
    facingMode?: "user" | "environment";
  };
  audio?: {
    sampleRate?: { ideal?: number };
    channels?: { ideal: 1 | 2 };
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
  screen?: {
    frameRate?: { ideal: number };
    displaySurface?: "browser" | "monitor" | "window";
  };
  networkStream?: {
    /**
     * URL 不在本契约中：凭据由受控配置持有，adapter 在 spawn 时经窄接口取用；
     * 日志 / 事件 / prompt 只允许脱敏 URL（stream-input.md 凭据管理节）。
     */
    transport?: "tcp" | "udp";
    segmentSeconds?: number;
  };
}

export interface LiveCaptureStartRequest {
  source: LiveCaptureSource;
  constraints?: LiveCaptureConstraints;
  /** 切片时长，默认 25_000（25s） */
  chunkDurationMs?: number;
  trace: TraceContext;
}

export interface LiveCaptureStartResult {
  /** 内部标识，commit 时携带 */
  sessionId: string;
  source: LiveCaptureSource;
  startedAt: number;
}

export interface LiveCaptureChunk {
  sessionId: string;
  sequenceNumber: number;
  startedAt: number;
  endedAt: number;
  bytes: Uint8Array;
  /** audio/webm | video/webm | video/mp4 等 */
  mime: string;
}

export interface LiveCaptureCommitRequest {
  sessionId: string;
  title: string;
  trace: TraceContext;
}

export interface LiveCaptureCommitResult {
  sessionId: string;
  /** workspace resource index id */
  resourceId: string;
  totalBytes: number;
  totalDurationMs: number;
  mime: string;
}

export type LiveCaptureErrorCode =
  | "live_capture_denied"
  | "live_capture_failed"
  | "live_capture_unsupported_source"
  | "live_capture_already_running"
  | "live_capture_not_found"
  | "live_capture_chunk_upload_failed"
  | "cancelled"
  | "io_error"
  | "permission_denied"
  | "process_failed"
  | "timeout"
  | "unavailable";

export class LiveCapturePortError extends Error {
  constructor(
    readonly code: LiveCaptureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LiveCapturePortError";
  }
}

export interface LiveCapturePort {
  start(
    req: LiveCaptureStartRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LiveCaptureStartResult>;
  /** 持续调用 chunk 直到 signal abort；内部维护 session。 */
  pullChunks(
    sessionId: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<LiveCaptureChunk>;
  /** 收尾：把累积 chunks 合并为单一 entry，落 artifact + resource index。 */
  commit(
    req: LiveCaptureCommitRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LiveCaptureCommitResult>;
  /** 放弃：不 commit，删除临时 state。 */
  cancel(sessionId: string, options?: { signal?: AbortSignal }): Promise<void>;
}
