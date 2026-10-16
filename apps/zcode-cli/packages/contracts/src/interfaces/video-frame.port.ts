import type { TraceContext } from "../tracing/tracer.js";

/**
 * 视频抽帧端口（video-frames.md 契约落地）。
 *
 * 首发消费方是 stream-monitor（RTSP 持续监控）：segment 关段后抽帧做分析。
 * 浏览器 worker / provider 投影分支为后续阶段（见 video-frames.md 落地范围节）。
 */
export interface VideoFrameRequest {
  /** file path 或 artifact URI */
  videoRef: string;
  mime: string;
  /** 抽帧时间点（毫秒） */
  timesMs: number[];
  trace: TraceContext;
}

export interface VideoFrame {
  timeMs: number;
  /** image/jpeg base64 dataUrl */
  imageDataUrl: string;
  width: number;
  height: number;
}

export type VideoFrameErrorCode =
  | "video_frame_extract_failed"
  | "video_unsupported_codec"
  | "video_unsupported_container"
  | "cancelled"
  | "io_error"
  | "permission_denied"
  | "process_failed"
  | "timeout"
  | "unavailable";

export class VideoFramePortError extends Error {
  constructor(
    readonly code: VideoFrameErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VideoFramePortError";
  }
}

export interface VideoFramePort {
  extractFrames(
    req: VideoFrameRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ frames: VideoFrame[] }>;
}
