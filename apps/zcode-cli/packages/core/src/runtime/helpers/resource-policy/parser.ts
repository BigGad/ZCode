import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Workspace 业务策略：video 抽帧 / audio 转写 / audio 合成的策略集合。
 * 文件位置：`./.zcode/resource-policy.yaml`（workspace 根目录）。
 * 优先级：CLI `--policy <tag>` > yaml byTag 命中 > yaml default > bundle default。
 */

export const frameSamplingModeSchema = z.enum([
  "uniform",
  "keyframes",
  "firstlast",
  "explicit",
]);

export const frameSamplingPolicySchema = z.object({
  intervalSec: z.number().positive().optional(),
  maxFrames: z.number().int().positive().optional(),
  mode: frameSamplingModeSchema.optional(),
  manualTimesMs: z.array(z.number().nonnegative()).optional(),
});

export const transcriptionEngineSchema = z.enum(["whisper-local", "whisper-api", "auto"]);

export const transcriptionPolicySchema = z.object({
  engine: transcriptionEngineSchema.optional(),
  language: z.string().min(1).optional(),
  diarize: z.boolean().optional(),
});

export const audioOutputFormatSchema = z.enum(["mp3", "wav", "ogg", "opus"]);

export const audioOutputPolicySchema = z.object({
  voice: z.string().min(1).optional(),
  format: audioOutputFormatSchema.optional(),
});

export const resourcePolicySchema = z
  .object({
    version: z.literal(1),
    video: z
      .object({
        frameSampling: z
          .object({
            default: frameSamplingPolicySchema.optional(),
            byTag: z.record(z.string(), frameSamplingPolicySchema).optional(),
          })
          .optional(),
      })
      .optional(),
    audio: z
      .object({
        transcription: z
          .object({
            default: transcriptionPolicySchema.optional(),
            byTag: z.record(z.string(), transcriptionPolicySchema).optional(),
          })
          .optional(),
      })
      .optional(),
    audioOutput: z
      .object({
        default: audioOutputPolicySchema.optional(),
        byTag: z.record(z.string(), audioOutputPolicySchema).optional(),
      })
      .optional(),
  })
  .strict();

export type FrameSamplingPolicy = z.infer<typeof frameSamplingPolicySchema>;
export type TranscriptionPolicy = z.infer<typeof transcriptionPolicySchema>;
export type AudioOutputPolicy = z.infer<typeof audioOutputPolicySchema>;
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>;

export interface LoadResourcePolicyOptions {
  /** 工作区根目录。policy 文件位于 `${workspaceRoot}/.zcode/resource-policy.yaml`。 */
  workspaceRoot: string;
}

/**
 * 解析 yaml 文本 → ResourcePolicy；schema 不匹配抛 `policy_invalid`。
 * 调用方负责捕获并降级（worker 报错但不默默猜测）。
 */
export function parseResourcePolicy(yamlText: string): ResourcePolicy {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ResourcePolicyParseError(
      `policy_invalid: yaml parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = resourcePolicySchema.safeParse(raw);
  if (!result.success) {
    throw new ResourcePolicyParseError(
      `policy_invalid: ${result.error.issues.map((i) => `${i.path.join(".") || "<root>"} ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export class ResourcePolicyParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResourcePolicyParseError";
  }
}

/**
 * 从 workspace 根目录加载 `.zcode/resource-policy.yaml`。
 * 文件不存在 → 返回 null（不报错，调用方走 bundle default）。
 * 文件存在但解析失败 → 抛 ResourcePolicyParseError。
 */
export async function loadResourcePolicy(
  options: LoadResourcePolicyOptions,
): Promise<ResourcePolicy | null> {
  const policyPath = join(options.workspaceRoot, ".zcode", "resource-policy.yaml");
  let text: string;
  try {
    text = await readFile(policyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ResourcePolicyParseError(
      `policy_invalid: cannot read ${policyPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseResourcePolicy(text);
}