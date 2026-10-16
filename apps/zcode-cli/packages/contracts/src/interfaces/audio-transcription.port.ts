import type { TraceContext } from "../tracing/tracer.js";

export interface AudioTranscriptionSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

export interface AudioTranscriptionRequest {
  audioRef: string;
  mime: string;
  language?: string;
  trace: TraceContext;
}

export interface AudioTranscriptionResult {
  segments: AudioTranscriptionSegment[];
  fullText: string;
  detectedLanguage?: string;
}

export type AudioTranscriptionErrorCode =
  | "transcription_engine_unavailable"
  | "transcription_failed"
  | "transcription_timeout"
  | "transcription_cancelled"
  | "audio_decode_failed"
  | "audio_unsupported_mime"
  | "cancelled"
  | "io_error"
  | "permission_denied"
  | "process_failed"
  | "timeout";

export class AudioTranscriptionPortError extends Error {
  constructor(
    readonly code: AudioTranscriptionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioTranscriptionPortError";
  }
}

export interface AudioTranscriptionPort {
  transcribe(
    req: AudioTranscriptionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AudioTranscriptionResult>;
}