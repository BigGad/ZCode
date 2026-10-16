import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactUrlString, type Logger } from "@zcode/contracts";
import { z } from "zod";

/**
 * 告警 / 生命周期事件持久化：`<alertStoreDir>/<streamId>.jsonl`。
 *
 * 边界（stream-input.md Continuous watch mode 节）：
 * - append-only 观测流，不写 session store（告警不是可恢复 / 分叉的对话状态）；
 * - 每行写入前经 zod 校验并统一 URL 脱敏（reason / summary 可能引用消息文本）；
 * - 去重键 `(streamId, segmentSeq)`：崩溃重跑同一段时不重复追加 analysis 行；
 * - 保留 STREAM_ALERT_RETENTION_DAYS 天（复用 logging retention 的按天先例语义）。
 */

export const STREAM_ALERT_RETENTION_DAYS = 30;

const ALERT_RECORD_VERSION = 1;

export type StreamAlertStatus = "normal" | "anomaly" | "analysis_failed";
export type StreamLifecycleStatus =
  | "started"
  | "stopped"
  | "reconnect"
  | "stream_down"
  | "gap";

const streamAlertRowSchema = z.object({
  v: z.literal(ALERT_RECORD_VERSION),
  ts: z.number().int().nonnegative(),
  streamId: z.string().min(1),
  kind: z.enum(["analysis", "lifecycle"]),
  status: z.string().min(1),
  segmentSeq: z.number().int().nonnegative().optional(),
  severity: z.enum(["info", "low", "medium", "high"]).optional(),
  reason: z.string().max(2000).optional(),
  modelSummary: z.string().max(4000).optional(),
  entryId: z.string().optional(),
  artifactUri: z.string().optional(),
  traceId: z.string().optional(),
});

export type StreamAlertRow = z.infer<typeof streamAlertRowSchema>;

export interface AppendStreamAlertInput {
  kind: "analysis" | "lifecycle";
  status: StreamAlertStatus | StreamLifecycleStatus;
  segmentSeq?: number;
  severity?: "info" | "low" | "medium" | "high";
  reason?: string;
  modelSummary?: string;
  entryId?: string;
  artifactUri?: string;
  traceId?: string;
}

export interface StreamAlertQuery {
  since?: number;
  until?: number;
  status?: string;
  limit?: number;
}

export interface StreamAlertStore {
  /** 返回写入的行；`deduplicated: true` 表示该 segment 的 analysis 行已存在，未重复追加。 */
  append(input: AppendStreamAlertInput): Promise<{ row: StreamAlertRow; deduplicated: boolean }>;
  query(query: StreamAlertQuery): Promise<StreamAlertRow[]>;
  pruneExpired(now: number): Promise<number>;
}

export interface CreateStreamAlertStoreOptions {
  alertStoreDir: string;
  streamId: string;
  clock?: () => number;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
}

export function createStreamAlertStore(options: CreateStreamAlertStoreOptions): StreamAlertStore {
  const clock = options.clock ?? Date.now;
  const filePath = join(options.alertStoreDir, `${options.streamId}.jsonl`);
  const logger = options.logger;
  /** 已写入的 analysis 去重键（streamId 固定，键 = segmentSeq）。 */
  const seenAnalysisSeqs = new Set<number>();

  async function loadExistingKeys(): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return;
    }
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const row = streamAlertRowSchema.parse(JSON.parse(line));
        if (row.kind === "analysis" && row.segmentSeq !== undefined) {
          seenAnalysisSeqs.add(row.segmentSeq);
        }
      } catch {
        // 损坏行跳过：append-only 观测流允许个别行不可读，不阻断后续写入。
      }
    }
  }

  let loaded = false;

  return {
    async append(input) {
      if (!loaded) {
        await loadExistingKeys();
        loaded = true;
      }
      if (input.kind === "analysis" && input.segmentSeq !== undefined) {
        if (seenAnalysisSeqs.has(input.segmentSeq)) {
          return {
            row: buildRow(input, clock, options.streamId),
            deduplicated: true,
          };
        }
        seenAnalysisSeqs.add(input.segmentSeq);
      }
      const row = buildRow(input, clock, options.streamId);
      const sanitized: StreamAlertRow = {
        ...row,
        ...(row.reason !== undefined ? { reason: redactUrlString(row.reason) } : {}),
        ...(row.modelSummary !== undefined
          ? { modelSummary: redactUrlString(row.modelSummary) }
          : {}),
      };
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(sanitized)}\n`, { flag: "a", encoding: "utf-8" });
      return { row: sanitized, deduplicated: false };
    },
    async query(query) {
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        return [];
      }
      const rows: StreamAlertRow[] = [];
      for (const line of content.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const row = streamAlertRowSchema.parse(JSON.parse(line));
          if (query.since !== undefined && row.ts < query.since) continue;
          if (query.until !== undefined && row.ts > query.until) continue;
          if (query.status !== undefined && row.status !== query.status) continue;
          rows.push(row);
        } catch (error) {
          logger?.debug("stream alert row unreadable; skipped", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const limit = query.limit ?? 1000;
      return rows.slice(-limit);
    },
    async pruneExpired(now) {
      const cutoff = now - STREAM_ALERT_RETENTION_DAYS * 86_400_000;
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        return 0;
      }
      const kept: string[] = [];
      let removed = 0;
      for (const line of content.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const row = streamAlertRowSchema.parse(JSON.parse(line));
          if (row.ts < cutoff) {
            removed += 1;
            continue;
          }
          kept.push(line);
        } catch {
          kept.push(line);
        }
      }
      if (removed === 0) return 0;
      if (kept.length === 0) {
        await unlink(filePath).catch(() => undefined);
        return removed;
      }
      const tempPath = `${filePath}.prune.${process.pid}.tmp`;
      await writeFile(tempPath, `${kept.join("\n")}\n`, "utf-8");
      await rename(tempPath, filePath);
      return removed;
    },
  };
}

function buildRow(
  input: AppendStreamAlertInput,
  clock: () => number,
  streamId: string,
): StreamAlertRow {
  return {
    v: ALERT_RECORD_VERSION,
    ts: clock(),
    streamId,
    kind: input.kind,
    status: input.status,
    ...(input.segmentSeq !== undefined ? { segmentSeq: input.segmentSeq } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.modelSummary !== undefined ? { modelSummary: input.modelSummary } : {}),
    ...(input.entryId !== undefined ? { entryId: input.entryId } : {}),
    ...(input.artifactUri !== undefined ? { artifactUri: input.artifactUri } : {}),
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  };
}
