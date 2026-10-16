import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "@zcode/contracts";

/**
 * 监控游标（watch-state）：`lastProcessedSegmentSeq` 的唯一持久化所有者。
 *
 * 幂等边界（stream-input.md Continuous watch mode 节）：
 * - tmp+rename 原子写（先例 = NodeToolArtifactStore 的媒体路径写）；
 * - 崩溃后重启重扫现存 segments，seq <= lastProcessed 跳过；
 * - state 落盘前崩溃 → 该 segment 重跑，上游由 resource index getById
 *   与 alert-store 去重键二次兜底；
 * - 文件损坏 → warn + 重置为 -1（重跑安全，两处幂等兜底仍在）。
 */

export interface StreamSegmentRecord {
  seq: number;
  artifactUri?: string;
  entryId?: string;
}

export interface StreamWatchState {
  monitorId: string;
  streamId: string;
  /** 已完整处理（含分析 + 告警落盘）的最大 segment seq；-1 表示尚未处理。 */
  lastProcessedSegmentSeq: number;
  /** 最近处理的 segments（倒序修剪），供 artifact 保留窗口清理。 */
  recentSegments: StreamSegmentRecord[];
  updatedAt: number;
}

const WATCH_STATE_FILE = "watch-state.json";
/** recentSegments 保留长度 = artifact 保留窗口（个）。 */
export const STREAM_ARTIFACT_KEEP_COUNT = 10;

export interface StreamWatchStateStore {
  load(): Promise<StreamWatchState | undefined>;
  save(state: StreamWatchState): Promise<void>;
  path: string;
}

export interface CreateWatchStateStoreOptions {
  stateDir: string;
  monitorId: string;
  streamId: string;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
}

export function createStreamWatchStateStore(
  options: CreateWatchStateStoreOptions,
): StreamWatchStateStore {
  const logger = options.logger;
  const statePath = join(options.stateDir, WATCH_STATE_FILE);
  return {
    path: statePath,
    async load() {
      let content: string;
      try {
        content = await readFile(statePath, "utf-8");
      } catch {
        return undefined;
      }
      try {
        const parsed = JSON.parse(content) as StreamWatchState;
        if (
          typeof parsed.lastProcessedSegmentSeq !== "number" ||
          !Array.isArray(parsed.recentSegments)
        ) {
          throw new Error("shape mismatch");
        }
        return parsed;
      } catch (error) {
        // 损坏文件重置为初始态：重跑最多重复一次分析 turn，alert 去重键兜底。
        logger?.warn("stream watch-state corrupt; resetting cursor", {
          path: statePath,
          reason: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
    async save(state) {
      const directory = dirname(statePath);
      await mkdir(directory, { recursive: true });
      const tempPath = join(
        directory,
        `.${WATCH_STATE_FILE}.${process.pid}.${Date.now()}.tmp`,
      );
      const payload = JSON.stringify(
        { ...state, updatedAt: Date.now() },
        null,
        2,
      );
      try {
        await writeFile(tempPath, payload, "utf-8");
        await rename(tempPath, statePath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

export function createInitialWatchState(
  monitorId: string,
  streamId: string,
): StreamWatchState {
  return {
    monitorId,
    streamId,
    lastProcessedSegmentSeq: -1,
    recentSegments: [],
    updatedAt: Date.now(),
  };
}

/** 推进游标并修剪 recentSegments；返回被修剪掉的记录（调用方负责 artifact 清理）。 */
export function advanceWatchState(
  state: StreamWatchState,
  record: StreamSegmentRecord,
): StreamSegmentRecord[] {
  state.lastProcessedSegmentSeq = Math.max(state.lastProcessedSegmentSeq, record.seq);
  state.recentSegments = [record, ...state.recentSegments.filter((item) => item.seq !== record.seq)];
  const dropped =
    state.recentSegments.length > STREAM_ARTIFACT_KEEP_COUNT
      ? state.recentSegments.slice(STREAM_ARTIFACT_KEEP_COUNT)
      : [];
  state.recentSegments = state.recentSegments.slice(0, STREAM_ARTIFACT_KEEP_COUNT);
  return dropped;
}
