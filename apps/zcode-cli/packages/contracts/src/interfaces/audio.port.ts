import type { TraceContext } from "../tracing/tracer.js";

export type AudioFormat = "wav" | "mp3" | "m4a" | "ogg" | "flac" | "opus" | "any";

export interface AudioMetadata {
  durationMs: number;
  sampleRate: number;
  channels: 1 | 2;
  bitsPerSample?: number;
  codec?: string;
}

export interface AudioDecodeRequest {
  data: Uint8Array;
  mime: string;
  targetSampleRate?: number;
  targetChannels?: 1 | 2;
  trace: TraceContext;
}

export interface AudioCaptureRequest {
  source: "mic" | "system" | "file";
  durationMs?: number;
  outputFormat?: AudioFormat;
  trace: TraceContext;
}

export interface AudioCaptureResult {
  data: Uint8Array;
  mime: string;
  metadata: AudioMetadata;
}

export type AudioErrorCode =
  | "audio_decode_failed"
  | "audio_encode_failed"
  | "audio_capture_failed"
  | "audio_capture_denied"
  | "audio_too_long"
  | "audio_unsupported_mime"
  | "cancelled"
  | "io_error"
  | "permission_denied"
  | "process_failed"
  | "timeout"
  | "unavailable";

export class AudioPortError extends Error {
  constructor(
    readonly code: AudioErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioPortError";
  }
}

export interface AudioPort {
  decode(
    req: AudioDecodeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ samples: Float32Array; metadata: AudioMetadata }>;
  encode(
    samples: Float32Array,
    metadata: AudioMetadata,
    format: AudioFormat,
  ): Promise<Uint8Array>;
  capture(
    req: AudioCaptureRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AudioCaptureResult>;
}