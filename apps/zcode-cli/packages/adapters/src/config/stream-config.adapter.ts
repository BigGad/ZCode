// Stream Config Adapter - ~/.zcode/cli/streams.json（RTSP 受控配置，0600）
//
// 设计边界（stream-input.md 凭据管理节）：
// - RTSP 凭据不并入 provider 配置（模型凭据域）、不进 workspace resource-policy
//   （per-workspace 业务策略）；两者靠 policyTag 关联。
// - 对外只暴露脱敏 view；原始 URL 经 getStreamUrl(streamId) 窄接口取用，
//   仅供 adapter 在 spawn ffmpeg 时传递，不进日志 / 事件 / prompt。

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { redactUrlString } from "@zcode/contracts";
import { z } from "zod";

export const DEFAULT_STREAMS_CONFIG_PATH = join(
  homedir(),
  ".zcode",
  "cli",
  "streams.json",
);

const STREAM_CONFIG_VERSION = 1;
export const DEFAULT_STREAM_SEGMENT_SECONDS = 30;
const MIN_STREAM_SEGMENT_SECONDS = 5;
const MAX_STREAM_SEGMENT_SECONDS = 600;

const streamEntrySchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u, "stream id must be 1-64 chars [a-zA-Z0-9_-]"),
  url: z
    .string()
    .url()
    .refine(
      (value) => /^((rts?ps?|rtmp[st]?|https?):\/\/)/iu.test(value),
      "url must be an rtsp://, rtmp://, or http(s):// stream URL",
    ),
  title: z.string().min(1).max(200).optional(),
  transport: z.enum(["tcp", "udp"]).default("tcp"),
  segmentSeconds: z
    .number()
    .int()
    .min(MIN_STREAM_SEGMENT_SECONDS)
    .max(MAX_STREAM_SEGMENT_SECONDS)
    .default(DEFAULT_STREAM_SEGMENT_SECONDS),
  policyTag: z.string().min(1).max(100).optional(),
  analysisPrompt: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().default(true),
});

const streamConfigSchema = z.object({
  version: z.literal(STREAM_CONFIG_VERSION),
  streams: z.array(streamEntrySchema).max(64),
});

export type StreamConfigEntry = z.infer<typeof streamEntrySchema>;

export interface RedactedStreamView {
  id: string;
  title?: string;
  /** 脱敏后的 URL（凭据剥除），用于 list 输出与诊断。 */
  urlRedacted: string;
  transport: "tcp" | "udp";
  segmentSeconds: number;
  policyTag?: string;
  analysisPrompt?: string;
  enabled: boolean;
}

export type StreamConfigErrorCode = "not_found" | "invalid" | "io_error";

export class StreamConfigError extends Error {
  constructor(
    readonly code: StreamConfigErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StreamConfigError";
  }
}

export interface LoadedStreamConfig {
  path: string;
  streams: StreamConfigEntry[];
}

/**
 * 解析 streams 配置路径：显式路径 > ZCODE_STREAM_CONFIG > 默认路径。
 * spec 定义见 stream-input.md 凭据管理节（用途 / 优先级 / 错误行为）。
 */
export function resolveStreamConfigPath(explicitPath?: string, env?: NodeJS.ProcessEnv): string {
  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    return resolve(explicitPath.trim());
  }
  const envPath = env?.ZCODE_STREAM_CONFIG;
  if (typeof envPath === "string" && envPath.trim().length > 0) {
    return resolve(envPath.trim());
  }
  return DEFAULT_STREAMS_CONFIG_PATH;
}

export async function loadStreamConfig(configPath: string): Promise<LoadedStreamConfig> {
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new StreamConfigError(
        "not_found",
        `Stream config not found: ${configPath}. Create it with entries: {"version":1,"streams":[{"id":"...","url":"rtsp://..."}]}`,
      );
    }
    throw new StreamConfigError("io_error", `Unable to read stream config: ${configPath}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new StreamConfigError("invalid", `Stream config is not valid JSON: ${configPath}`, {
      cause: error,
    });
  }
  const result = streamConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new StreamConfigError("invalid", `Stream config is invalid: ${detail}`);
  }
  const ids = new Set<string>();
  for (const stream of result.data.streams) {
    if (ids.has(stream.id)) {
      throw new StreamConfigError("invalid", `Duplicate stream id: ${stream.id}`);
    }
    ids.add(stream.id);
  }
  return { path: configPath, streams: result.data.streams };
}

export function findStreamEntry(
  config: LoadedStreamConfig,
  streamId: string,
): StreamConfigEntry | undefined {
  return config.streams.find((stream) => stream.id === streamId);
}

/** 脱敏 view：list 输出 / 日志 / 诊断只允许经此构造。 */
export function redactedStreamView(entry: StreamConfigEntry): RedactedStreamView {
  return {
    id: entry.id,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    urlRedacted: redactUrlString(entry.url),
    transport: entry.transport,
    segmentSeconds: entry.segmentSeconds,
    ...(entry.policyTag !== undefined ? { policyTag: entry.policyTag } : {}),
    ...(entry.analysisPrompt !== undefined ? { analysisPrompt: entry.analysisPrompt } : {}),
    enabled: entry.enabled,
  };
}

/**
 * 写入（或初始化）streams.json：目录 0700、文件 0600；tmp+rename 原子替换。
 * Windows 无 POSIX 权限模型，mode 尽力而为（spec 安全节声明剩余风险）。
 */
export async function writeStreamConfig(
  configPath: string,
  streams: readonly StreamConfigEntry[],
): Promise<void> {
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(
    directory,
    `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const content = `${JSON.stringify({ version: STREAM_CONFIG_VERSION, streams }, null, 2)}\n`;
  await writeFile(tempPath, content, { mode: 0o600, encoding: "utf-8" });
  try {
    await renameWithModeFix(tempPath, configPath);
  } catch (error) {
    throw new StreamConfigError("io_error", `Unable to write stream config: ${configPath}`, {
      cause: error,
    });
  }
}

async function renameWithModeFix(from: string, to: string): Promise<void> {
  await rename(from, to);
  try {
    const info = await stat(to);
    // 非Windows：rename 保留临时文件的 0600；这里兜底确保最终权限收敛。
    if ((info.mode & 0o777) !== 0o600) {
      await chmod(to, 0o600);
    }
  } catch {
    // 权限收敛失败不阻断写入；Windows 上该调用无 POSIX 语义。
  }
}
