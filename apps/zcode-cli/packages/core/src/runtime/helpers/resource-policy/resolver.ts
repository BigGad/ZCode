import type { WorkspaceResourceIndexEntry } from "@zcode/contracts";
import type {
  AudioOutputPolicy,
  FrameSamplingPolicy,
  ResourcePolicy,
  TranscriptionPolicy,
} from "./parser.js";

/**
 * 业务策略优先级合并：
 * 1. entry.meta.policyTag 命中 yaml `byTag[tag]`
 * 2. yaml `default`
 * 3. 返回 null；调用方决定是否走 bundle default 或抛 `policy_not_configured`
 */
export function resolvePolicyForEntry(
  policy: ResourcePolicy,
  entry: Pick<WorkspaceResourceIndexEntry, "meta">,
  kind: "video" | "audio" | "audioOutput",
  field: "frameSampling" | "transcription" | undefined,
): FrameSamplingPolicy | TranscriptionPolicy | AudioOutputPolicy | null {
  const tag = entry.meta?.policyTag;
  switch (kind) {
    case "video":
      if (field !== "frameSampling") return null;
      return resolveFromMap(
        policy.video?.frameSampling?.byTag,
        policy.video?.frameSampling?.default,
        tag,
      ) as FrameSamplingPolicy | null;
    case "audio":
      if (field !== "transcription") return null;
      return resolveFromMap(
        policy.audio?.transcription?.byTag,
        policy.audio?.transcription?.default,
        tag,
      ) as TranscriptionPolicy | null;
    case "audioOutput":
      return resolveFromMap(
        policy.audioOutput?.byTag,
        policy.audioOutput?.default,
        tag,
      ) as AudioOutputPolicy | null;
    default:
      return null;
  }
}

function resolveFromMap<T>(
  byTag: Record<string, T> | undefined,
  defaultPolicy: T | undefined,
  tag: string | undefined,
): T | null {
  if (byTag && tag && Object.prototype.hasOwnProperty.call(byTag, tag)) {
    const matched = byTag[tag];
    if (matched !== undefined) return matched;
  }
  return defaultPolicy ?? null;
}