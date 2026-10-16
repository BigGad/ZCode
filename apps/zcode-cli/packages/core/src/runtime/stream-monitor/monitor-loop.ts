import type { Logger, SessionId, TraceContext } from "@zcode/contracts";
import { createRootTraceContext } from "@zcode/contracts";
import {
  createStreamAlertStore,
  type StreamAlertRow,
  type StreamAlertStore,
} from "./alert-store.js";
import {
  buildAnalysisPrompt,
  parseStreamAnalysisResponse,
  type StreamJudgement,
} from "./alert-judge.js";
import {
  processStreamSegment,
  streamMonitorSessionId,
  type StreamSegmentPipelineDeps,
} from "./segment-pipeline.js";
import {
  advanceWatchState,
  createInitialWatchState,
  createStreamWatchStateStore,
  type StreamWatchState,
} from "./watch-state.js";

/**
 * 持续监控循环（stream-input.md Continuous watch mode 节）。
 *
 * 所有者与事件顺序：`zcode stream watch` CLI 进程 → createStreamMonitor().run(signal)：
 *   capture.start → watchClosedSegments 逐段 → segment-pipeline（artifact→帧→index）
 *   → 分析 turn（runAnalysisTurn，deny 权限面由注入方保证）→ alert-judge
 *   → alert-store → watch-state 推进 → 旧 artifact 清理。
 *
 * 失败恢复：capture 进程退出 → 指数退避重连（STREAM_RECONNECT_* 常量）；
 * 状态翻转时写一次 stream_down；分析失败写 analysis_failed 不阻塞后续；
 * 崩溃重启后由 watch-state cursor + index getById + alert 去重键三方幂等兜底。
 */

const STREAM_RECONNECT_INITIAL_DELAY_MS = 1_000;
const STREAM_RECONNECT_MAX_DELAY_MS = 60_000;
/** 连续失败达该次数后写一次 stream_down（状态翻转去重：恢复后重置）。 */
const STREAM_DOWN_AFTER_CONSECUTIVE_FAILURES = 3;

export interface StreamMonitorCapture {
  start(signal?: AbortSignal): Promise<void>;
  watchClosedSegments(signal: AbortSignal): AsyncIterable<{ seq: number; path: string }>;
  /** 已关闭 segment 字节读取（I/O 收敛在 capture adapter）。 */
  readSegment(path: string): Promise<Uint8Array>;
  /**
   * 删除已处理 segment 文件（可选；长驻 watch 防磁盘无限增长——artifact 已持有
   * 提交副本，原始文件没有保留价值）。失败由注入方兜底，不阻塞循环。
   */
  deleteSegment?(path: string): Promise<void>;
  stop(): Promise<void>;
}

export interface StreamMonitorDeps {
  stream: {
    id: string;
    title?: string;
    /** 受控配置原始 URL；只透传给 capture.start，不进日志 / prompt / 事件。 */
    url: string;
    transport: "tcp" | "udp";
    segmentSeconds: number;
    policyTag?: string;
    analysisPrompt?: string;
  };
  monitorId: string;
  workspaceKey: string;
  workspacePath: string;
  /** watch-state 目录（私有 stream-cache：<storageRoot>/cli/stream-cache/<monitorId>）。 */
  stateDir: string;
  /** 告警 JSONL 目录（~/.zcode/cli/stream-events）。 */
  alertStoreDir: string;
  capture: StreamMonitorCapture;
  /** segment 字节读取由 capture adapter 承载（I/O 收敛），core 不直接触 fs。 */
  pipeline: Omit<StreamSegmentPipelineDeps, "monitorSessionId" | "readSegment">;
  /**
   * 分析 turn 入口（由 CLI 以 createZCodeApp + deny 权限面装配后注入）。
   * core 不依赖 bootstrap；权限语义独立于交互 session（spec 声明）。
   */
  runAnalysisTurn(req: {
    prompt: string;
    imageDataUrls: string[];
    signal?: AbortSignal;
  }): Promise<string>;
  /** 告警通知（row + 去重标记；仅 status=anomaly / lifecycle 关键事件时触发）。 */
  onAlert?(alert: StreamAlertRow & { deduplicated: boolean }): void;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
  clock?: () => number;
  /** 重连延迟序列覆盖（测试注入）。 */
  reconnectDelaysMs?: readonly number[];
}

export interface StreamMonitor {
  /** 运行至 signal abort 或连续失败；返回是否因 abort 退出。 */
  run(signal: AbortSignal): Promise<{ stoppedReason: "aborted" | "exhausted" }>;
  readonly alerts: StreamAlertStore;
}

export function createStreamMonitor(deps: StreamMonitorDeps): StreamMonitor {
  const clock = deps.clock ?? Date.now;
  const logger = deps.logger;
  const alerts = createStreamAlertStore({
    alertStoreDir: deps.alertStoreDir,
    streamId: deps.stream.id,
    clock,
    logger,
  });
  const reconnectDelays = deps.reconnectDelaysMs ?? buildExponentialBackoff();
  return { alerts, run: (signal) => runMonitor(deps, alerts, reconnectDelays, logger, signal) };
}

function buildExponentialBackoff(): number[] {
  const delays: number[] = [];
  for (let delay = STREAM_RECONNECT_INITIAL_DELAY_MS; delay < STREAM_RECONNECT_MAX_DELAY_MS; delay *= 2) {
    delays.push(delay);
  }
  delays.push(STREAM_RECONNECT_MAX_DELAY_MS);
  return delays;
}

async function runMonitor(
  deps: StreamMonitorDeps,
  alerts: StreamAlertStore,
  reconnectDelays: readonly number[],
  logger: Pick<Logger, "debug" | "info" | "warn" | "error"> | undefined,
  signal: AbortSignal,
): Promise<{ stoppedReason: "aborted" | "exhausted" }> {
  const stateStore = createStreamWatchStateStore({
    stateDir: deps.stateDir,
    monitorId: deps.monitorId,
    streamId: deps.stream.id,
    logger,
  });
  const state: StreamWatchState =
    (await stateStore.load()) ?? createInitialWatchState(deps.monitorId, deps.stream.id);
  const trace = createRootTraceContext({
    sessionId: streamMonitorSessionId(deps.stream.id) as SessionId,
  });

  await alerts.append({ kind: "lifecycle", status: "started" });
  // 崩溃恢复 gap 检测（stream-input.md 失败恢复节）：上次活动距本次启动超过
  // 一个 segment 周期视为宕机窗口，写一次 gap 事件。RTSP/FLV 均无历史回看，
  // 窗口内的流数据不可恢复，gap 行是对外稳定的丢失声明。
  if (state.recentSegments.length > 0 || state.lastProcessedSegmentSeq >= 0) {
    const resumedAt = deps.clock?.() ?? Date.now();
    const gapMs = resumedAt - state.updatedAt;
    if (gapMs > deps.stream.segmentSeconds * 1_000) {
      await alerts.append({
        kind: "lifecycle",
        status: "gap",
        reason: `watch interrupted for ${Math.round(gapMs / 1_000)}s before restart; segments in this window are lost`,
      });
      logger?.warn("stream monitor restart gap detected", {
        streamId: deps.stream.id,
        gapMs,
      });
    }
  }
  let consecutiveFailures = 0;
  let streamDownEmitted = false;

  while (!signal.aborted) {
    try {
      await deps.capture.start(signal);
      logger?.info("stream monitor capture started", { streamId: deps.stream.id });
      consecutiveFailures = 0;
      if (streamDownEmitted) {
        streamDownEmitted = false;
        await alerts.append({ kind: "lifecycle", status: "reconnect", reason: "stream recovered" });
      }

      for await (const segment of deps.capture.watchClosedSegments(signal)) {
        if (signal.aborted) break;
        if (segment.seq <= state.lastProcessedSegmentSeq) continue;
        await processSegmentSafely(deps, alerts, state, stateStore, trace, logger, segment, signal);
      }
      // watchClosedSegments 正常结束 = capture 进程退出（断流）。
      consecutiveFailures += 1;
      logger?.warn("stream capture ended; scheduling reconnect", {
        streamId: deps.stream.id,
        consecutiveFailures,
      });
      if (
        consecutiveFailures >= STREAM_DOWN_AFTER_CONSECUTIVE_FAILURES &&
        !streamDownEmitted
      ) {
        streamDownEmitted = true;
        const down = await alerts.append({
          kind: "lifecycle",
          status: "stream_down",
          reason: `capture ended ${consecutiveFailures} times consecutively`,
        });
        deps.onAlert?.({ ...down.row, deduplicated: down.deduplicated });
      }
    } catch (error) {
      if (signal.aborted) break;
      consecutiveFailures += 1;
      logger?.error(
        "stream monitor capture failed",
        toError(error),
        {
          streamId: deps.stream.id,
          consecutiveFailures,
          // 错误文本可能含 URL；不落 error.message，只落类型名。
          errorType: error instanceof Error ? error.name : typeof error,
        },
      );
      if (consecutiveFailures >= STREAM_DOWN_AFTER_CONSECUTIVE_FAILURES && !streamDownEmitted) {
        streamDownEmitted = true;
        const down = await alerts.append({
          kind: "lifecycle",
          status: "stream_down",
          reason: "capture failed to start repeatedly",
        });
        deps.onAlert?.({ ...down.row, deduplicated: down.deduplicated });
      }
    } finally {
      await deps.capture.stop().catch(() => undefined);
    }

    if (signal.aborted) break;
    const delay = reconnectDelays[Math.min(consecutiveFailures - 1, reconnectDelays.length - 1)];
    if (delay === undefined) {
      return { stoppedReason: "exhausted" };
    }
    await delayAsync(delay, signal);
  }

  await deps.capture.stop().catch(() => undefined);
  await alerts.append({ kind: "lifecycle", status: "stopped" }).catch(() => undefined);
  return { stoppedReason: signal.aborted ? "aborted" : "exhausted" };
}

async function processSegmentSafely(
  deps: StreamMonitorDeps,
  alerts: StreamAlertStore,
  state: StreamWatchState,
  stateStore: ReturnType<typeof createStreamWatchStateStore>,
  trace: TraceContext,
  logger: Pick<Logger, "debug" | "info" | "warn" | "error"> | undefined,
  segment: { seq: number; path: string },
  signal: AbortSignal,
): Promise<void> {
  try {
    const processed = await processStreamSegment(
      {
        ...deps.pipeline,
        monitorSessionId: streamMonitorSessionId(deps.stream.id),
        readSegment: (path: string) => deps.capture.readSegment(path),
      },
      {
        streamId: deps.stream.id,
        segmentSeq: segment.seq,
        segmentPath: segment.path,
        segmentSeconds: deps.stream.segmentSeconds,
        trace,
        // 抽帧与下游 I/O 都接 abort：stop/deadline/Ctrl+C 立即中断长操作。
        signal,
      },
    );

    if (processed.frameDataUrls.length > 0) {
      const prompt = buildAnalysisPrompt({
        streamId: deps.stream.id,
        streamTitle: deps.stream.title,
        segmentSeq: segment.seq,
        customPrompt: deps.stream.analysisPrompt,
      });
      try {
        const response = await deps.runAnalysisTurn({
          prompt,
          imageDataUrls: processed.frameDataUrls,
          signal,
        });
        await recordVerdict(deps, alerts, segment.seq, processed.entryId, processed.artifactUri, trace.traceId, response);
      } catch (error) {
        // stop/deadline 触发的中断不是分析失败：游标不推进，下次启动重放该段。
        if (signal.aborted) return;
        logger?.warn("analysis turn failed", {
          streamId: deps.stream.id,
          seq: segment.seq,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        await alerts.append({
          kind: "analysis",
          status: "analysis_failed",
          segmentSeq: segment.seq,
          reason: "analysis turn failed",
          entryId: processed.entryId,
          traceId: trace.traceId,
        });
      }
    }

    // 游标推进（tmp+rename 原子写）并清理保留窗口外的旧 artifact。
    const dropped = advanceWatchState(state, {
      seq: segment.seq,
      artifactUri: processed.artifactUri,
      entryId: processed.entryId,
    });
    await stateStore.save(state);
    await cleanupDroppedArtifacts(deps, dropped, logger);
    // 原始 segment 文件在游标推进后删除：重启重放只依赖游标与现存未处理文件，
    // 已处理文件的删除不影响幂等门；此时删除失败最多延迟磁盘回收。
    await deps.capture.deleteSegment?.(segment.path);
  } catch (error) {
    // 同上：shutdown 中断不算段处理失败，静默让出循环收尾。
    if (signal.aborted) return;
    // 单段失败不阻塞循环：写事件后跳过该段（不推进游标，重启后重跑一次）。
    logger?.error(
      "segment processing failed; skipping",
      toError(error),
      {
        streamId: deps.stream.id,
        seq: segment.seq,
        errorType: error instanceof Error ? error.name : typeof error,
      },
    );
    await alerts
      .append({
        kind: "analysis",
        status: "analysis_failed",
        segmentSeq: segment.seq,
        reason: "segment processing failed",
      })
      .catch(() => undefined);
  }
}

async function recordVerdict(
  deps: StreamMonitorDeps,
  alerts: StreamAlertStore,
  segmentSeq: number,
  entryId: string,
  artifactUri: string | undefined,
  traceId: string | undefined,
  response: string,
): Promise<void> {
  const judgement: StreamJudgement = parseStreamAnalysisResponse(response);
  if (!judgement.ok) {
    await alerts.append({
      kind: "analysis",
      status: "analysis_failed",
      segmentSeq,
      reason: judgement.failureReason,
      entryId,
      traceId,
    });
    return;
  }
  const { row, deduplicated } = await alerts.append({
    kind: "analysis",
    status: judgement.verdict.status,
    segmentSeq,
    severity: judgement.verdict.severity,
    reason: judgement.verdict.reason,
    modelSummary: response.length > 4000 ? `${response.slice(0, 4000)}…` : response,
    entryId,
    artifactUri,
    traceId,
  });
  deps.onAlert?.({
    ...row,
    deduplicated,
  });
}

async function cleanupDroppedArtifacts(
  deps: StreamMonitorDeps,
  dropped: readonly { seq: number; artifactUri?: string }[],
  logger: Pick<Logger, "debug" | "warn" | "error" | "info"> | undefined,
): Promise<void> {
  if (dropped.length === 0) return;
  const artifactStore = deps.pipeline.artifactStore;
  if (typeof artifactStore.deleteToolResultArtifact !== "function") {
    // store 不支持删除：降级声明，artifact 由上层 retention 策略处理。
    logger?.debug("artifact store lacks delete; retention delegated to upper layer", {
      count: dropped.length,
    });
    return;
  }
  for (const record of dropped) {
    if (record.artifactUri === undefined) continue;
    try {
      await artifactStore.deleteToolResultArtifact({ uri: record.artifactUri });
    } catch (error) {
      logger?.warn("failed to delete expired segment artifact", {
        seq: record.seq,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

function delayAsync(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 日志契约要求 error 传 Error 实例；非 Error 抛出物包装后落日志（不含凭据文本）。 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
