import type {
  ImageProcessorPort,
  Logger,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  VideoFramePort,
  WorkspaceResourceIndexEntry,
  WorkspaceResourceIndexPort,
} from "@zcode/contracts";
import type { FrameSamplingPolicy } from "../helpers/resource-policy/parser.js";
import { resolvePolicyForEntry } from "../helpers/resource-policy/resolver.js";
import type { ResourcePolicy } from "../helpers/resource-policy/parser.js";

/**
 * 单个已关闭 segment 的处理管线：
 * artifact 写入 → 抽帧 → 预算处理 → resource index upsert（committed entry）。
 *
 * 安全红线落法（stream-input.md Continuous watch mode 节）：进入模型输入的只有
 * 本管线产出的、经 imageProcessorPort.prepareForModel 预算处理后的帧；
 * live chunk（正在写入的 segment）在任何路径下都不进入本管线（由关段判定保证）。
 */

const STREAM_ARTIFACT_SESSION_PREFIX = "stream";
const STREAM_ARTIFACT_TOOL_NAME = "stream_segment";
const STREAM_ARTIFACT_CONTENT_TYPE = "video/mp4";
const STREAM_ARTIFACT_EXTENSION = ".mp4";
const STREAM_ENTRY_KIND = "stream" as const;
const STREAM_ENTRY_ORIGIN = "device_stream" as const;

/** 单帧 base64 上限（超出剥离该帧）：与媒体预算单帧阈值一致。 */
const STREAM_FRAME_MAX_BASE64_BYTES = 5 * 1024 * 1024;
const STREAM_FRAME_MAX_RAW_BYTES = 6 * 1024 * 1024;
/** 单帧最长边上限（像素）：监控场景不做缩放，仅约束异常大帧。 */
const STREAM_FRAME_MAX_DIMENSION = 4096;
/** uniform 抽帧默认间隔与上限（policy 缺省时）。 */
const DEFAULT_FRAME_INTERVAL_SEC = 10;
const DEFAULT_FRAME_MAX_COUNT = 6;

export interface StreamSegmentPipelineDeps {
  videoFramePort: VideoFramePort;
  imageProcessorPort: ImageProcessorPort;
  artifactStore: ToolArtifactStorePort;
  workspaceResourceIndex: WorkspaceResourceIndexPort;
  /** 身份 key：`workspaceIdentity?.trim() || workspacePath`（AGENTS.md Workspace Identity）。 */
  workspaceKey: string;
  /** workspace 真实文件路径（entry.workspacePath 展示用）。 */
  workspacePath: string;
  /** 已关闭 segment 字节读取（I/O 收敛在 capture adapter，core 不直接触 fs）。 */
  readSegment: (path: string) => Promise<Uint8Array>;
  /** artifact 归属 sessionId（stream 域专用，非对话 session）。 */
  monitorSessionId: string;
  policyTag?: string;
  /** 已解析的 workspace resource policy；undefined 时用内置默认抽帧策略。 */
  resourcePolicy?: ResourcePolicy;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
}

export interface ProcessStreamSegmentInput {
  streamId: string;
  segmentSeq: number;
  /** 已关闭 segment 的本地路径（capture adapter 产出）。 */
  segmentPath: string;
  segmentSeconds: number;
  trace: TraceContext;
  signal?: AbortSignal;
}

export interface ProcessedStreamSegment {
  entryId: string;
  entry: WorkspaceResourceIndexEntry;
  artifactUri?: string;
  /** 预算处理后的帧（image/jpeg dataUrl），按时间升序。 */
  frameDataUrls: string[];
  frameSamplingStatus: "ready" | "failed";
}

/** deterministic entry id：upsert 天然幂等（崩溃重跑不产生重复 entry）。 */
export function streamEntryId(streamId: string, segmentSeq: number): string {
  return `stream-${streamId}-${String(segmentSeq).padStart(6, "0")}`;
}

export function streamMonitorSessionId(streamId: string): string {
  return `${STREAM_ARTIFACT_SESSION_PREFIX}-${streamId}`;
}

export async function processStreamSegment(
  deps: StreamSegmentPipelineDeps,
  input: ProcessStreamSegmentInput,
): Promise<ProcessedStreamSegment> {
  const entryId = streamEntryId(input.streamId, input.segmentSeq);
  const existing = await deps.workspaceResourceIndex.getById(deps.workspaceKey, entryId, {
    trace: input.trace,
    signal: input.signal,
  });

  let artifactUri = existing?.variants.find((variant) => variant.kind === "original")?.artifactUri;
  if (artifactUri === undefined) {
    artifactUri = await writeSegmentArtifact(deps, input);
  }

  const frames = await extractBudgetedFrames(deps, input);
  const entry = await upsertStreamEntry(deps, input, {
    entryId,
    artifactUri,
    frameSamplingStatus: frames.length > 0 ? "ready" : "failed",
    existing,
  });
  return {
    entryId,
    entry,
    artifactUri,
    frameDataUrls: frames,
    frameSamplingStatus: frames.length > 0 ? "ready" : "failed",
  };
}

async function writeSegmentArtifact(
  deps: StreamSegmentPipelineDeps,
  input: ProcessStreamSegmentInput,
): Promise<string | undefined> {
  if (typeof deps.artifactStore.writeToolResultBinaryArtifact !== "function") {
    deps.logger?.warn("artifact store lacks binary write; segment not persisted", {
      streamId: input.streamId,
      seq: input.segmentSeq,
    });
    return undefined;
  }
  let bytes: Uint8Array;
  try {
    bytes = await deps.readSegment(input.segmentPath);
  } catch (error) {
    deps.logger?.warn("failed to read closed segment file", {
      streamId: input.streamId,
      seq: input.segmentSeq,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const result = await deps.artifactStore.writeToolResultBinaryArtifact({
    sessionId: deps.monitorSessionId as SessionId,
    toolCallId: `segment-${String(input.segmentSeq).padStart(6, "0")}`,
    toolName: STREAM_ARTIFACT_TOOL_NAME,
    content: bytes,
    contentType: STREAM_ARTIFACT_CONTENT_TYPE,
    extension: STREAM_ARTIFACT_EXTENSION,
    retention: "temporary",
    trace: input.trace,
  }, input.signal ? { signal: input.signal } : undefined);
  return result.uri;
}

async function extractBudgetedFrames(
  deps: StreamSegmentPipelineDeps,
  input: ProcessStreamSegmentInput,
): Promise<string[]> {
  const timesMs = computeFrameTimesMs(deps, input);
  if (timesMs.length === 0) return [];
  let extracted: Awaited<ReturnType<VideoFramePort["extractFrames"]>>["frames"];
  try {
    ({ frames: extracted } = await deps.videoFramePort.extractFrames({
      videoRef: input.segmentPath,
      mime: STREAM_ARTIFACT_CONTENT_TYPE,
      timesMs,
      trace: input.trace,
    }, input.signal ? { signal: input.signal } : undefined));
  } catch (error) {
    deps.logger?.warn("frame extraction failed", {
      streamId: input.streamId,
      seq: input.segmentSeq,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const frameDataUrls: string[] = [];
  for (const frame of extracted) {
    try {
      const prepared = await deps.imageProcessorPort.prepareForModel({
        data: base64ToBytes(frame.imageDataUrl),
        mediaType: "image/jpeg",
        // 监控帧不缩放：仅做预算约束（缩放交给 provider 侧分辨率）。
        maxDimension: STREAM_FRAME_MAX_DIMENSION,
        maxBase64Bytes: STREAM_FRAME_MAX_BASE64_BYTES,
        maxRawBytes: STREAM_FRAME_MAX_RAW_BYTES,
        trace: input.trace,
      }, input.signal ? { signal: input.signal } : undefined);
      frameDataUrls.push(`data:image/jpeg;base64,${bytesToBase64(prepared.data)}`);
    } catch (error) {
      // 单帧预算失败（> 上限且无法压缩）剥离该帧，不中断 segment 处理。
      deps.logger?.debug("frame dropped by media budget", {
        streamId: input.streamId,
        seq: input.segmentSeq,
        timeMs: frame.timeMs,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return frameDataUrls;
}

function computeFrameTimesMs(
  deps: StreamSegmentPipelineDeps,
  input: ProcessStreamSegmentInput,
): number[] {
  const syntheticEntry = { meta: { policyTag: deps.policyTag } };
  const policy = (deps.resourcePolicy
    ? resolvePolicyForEntry(deps.resourcePolicy, syntheticEntry, "video", "frameSampling")
    : null) as FrameSamplingPolicy | null;
  const intervalSec = policy?.intervalSec ?? DEFAULT_FRAME_INTERVAL_SEC;
  const maxFrames = policy?.maxFrames ?? DEFAULT_FRAME_MAX_COUNT;
  if (policy?.mode === "explicit" && policy.manualTimesMs !== undefined) {
    return [...policy.manualTimesMs].sort((left, right) => left - right);
  }
  if (policy?.mode === "firstlast") {
    return [0, Math.max(0, input.segmentSeconds * 1000 - 1)];
  }
  // uniform（含 keyframes 降级为 uniform）：segment 时长已知近似值，超出时长的
  // 时间点由抽帧 adapter 跳过（无产出帧），无需预探测时长。
  const intervalMs = Math.max(1, Math.round(intervalSec * 1000));
  const durationMs = Math.max(intervalMs, input.segmentSeconds * 1000);
  const times: number[] = [];
  for (let time = 0; time < durationMs && times.length < maxFrames; time += intervalMs) {
    times.push(time);
  }
  return times;
}

async function upsertStreamEntry(
  deps: StreamSegmentPipelineDeps,
  input: ProcessStreamSegmentInput,
  context: {
    entryId: string;
    artifactUri?: string;
    frameSamplingStatus: "ready" | "failed";
    existing?: WorkspaceResourceIndexEntry;
  },
): Promise<WorkspaceResourceIndexEntry> {
  const now = Date.now();
  const entry: WorkspaceResourceIndexEntry = {
    id: context.entryId,
    workspaceIdentity: deps.workspaceKey,
    workspacePath: deps.workspacePath,
    kind: STREAM_ENTRY_KIND,
    title: `stream segment ${String(input.segmentSeq).padStart(6, "0")}`,
    filename: input.segmentPath.split(/[\\/]/u).pop(),
    sourceOrigin: STREAM_ENTRY_ORIGIN,
    addedAt: context.existing?.addedAt ?? now,
    updatedAt: now,
    variants: context.artifactUri
      ? [
          {
            kind: "original",
            mime: STREAM_ARTIFACT_CONTENT_TYPE,
            bytes: 0,
            artifactUri: context.artifactUri,
          },
        ]
      : [],
    references: context.existing?.references ?? 0,
    tags: ["stream-watch", input.streamId],
    meta: {
      durationMs: input.segmentSeconds * 1000,
      ...(deps.policyTag !== undefined ? { policyTag: deps.policyTag } : {}),
      policySource: "auto-detected",
      frameSamplingStatus: context.frameSamplingStatus,
    },
  };
  return await deps.workspaceResourceIndex.upsert(entry, {
    trace: input.trace,
    signal: input.signal,
  });
}

function base64ToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
