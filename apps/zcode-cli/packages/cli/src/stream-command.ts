import {
  loadStreamConfig,
  redactedStreamView,
  resolveStreamConfigPath,
  StreamConfigError,
} from "@zcode/adapters";
import { createStreamAlertStore, type StreamAlertRow } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import {
  resolveAlertStoreDir,
  runStreamMonitorCommand,
  STREAM_ID_PATTERN,
} from "./stream-monitor-runner.js";
import { stopStreamWatch, watchPidFilePath } from "./stream-watch-daemon.js";

/**
 * `zcode stream` —— RTSP 网络流持续监控 CLI（stream-input.md 入口适配节）。
 *
 * 子命令：
 *   zcode stream list                       列出受控配置中的流（URL 脱敏）
 *   zcode stream analyze --stream <id>      抓取一个已关闭 segment 并分析（垂直切片）
 *   zcode stream watch --stream <id>        长驻持续监控（Ctrl+C 干净退出）
 *   zcode stream events --stream <id>       查询告警 / 生命周期事件 JSONL
 *
 * 安全边界（spec 凭据管理节）：RTSP URL 只透传给 ffmpeg argv，不进日志 /
 * 错误文本 / 分析 prompt；CLI 输出一律经 redactedStreamView 或不含凭据字段。
 * analyze/watch 的运行时装配见 stream-monitor-runner.ts。
 */

const EVENTS_FOLLOW_POLL_INTERVAL_MS = 5_000;

export interface StreamCommandOptions {
  subcommand?: string;
  stream?: string;
  once?: boolean;
  follow?: boolean;
  since?: string;
  until?: string;
  limit?: number;
  status?: string;
  config?: string;
  version?: string;
  /** watch 定时结束（stream-input.md「运行时长与后台常驻」节）。 */
  duration?: string;
  forever?: boolean;
  /** 内部旗标：--forever 父进程 spawn 的后台子进程标记，避免再 spawn。 */
  daemon?: boolean;
}

/** 测试注入点；生产路径全部使用真实实现。 */
export interface StreamCommandDependencies {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export async function runStreamCommand(
  ctx: RunContext,
  options: GlobalOptions,
  streamOptions: StreamCommandOptions,
  deps: StreamCommandDependencies = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const subcommand = streamOptions.subcommand ?? "";
  try {
    switch (subcommand) {
      case "list":
        return await runStreamList(ctx, streamOptions, env, options);
      case "events":
        return await runStreamEvents(ctx, options, streamOptions, deps);
      case "analyze":
      case "watch":
        return await runStreamMonitorCommand(ctx, options, streamOptions, env);
      case "stop":
        return await runStreamStop(ctx, streamOptions);
      case "":
        ctx.stderr.write(
          "Usage: zcode stream <list|analyze|watch|events|stop> --stream <id>\n",
        );
        return 1;
      default:
        ctx.stderr.write(`Unknown stream subcommand: ${subcommand}\n`);
        return 1;
    }
  } catch (error) {
    // StreamConfigError / LiveCapturePortError 文本不含 URL 凭据（adapter 侧已保证）。
    ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * `zcode stream stop`：停止后台常驻 watch（--forever）。前台 watch 由用户
 * Ctrl+C 结束，无 pid 文件可停。返回码：0 已停止 / 1 未在运行或停止失败。
 */
async function runStreamStop(
  ctx: RunContext,
  streamOptions: StreamCommandOptions,
): Promise<number> {
  const streamId = streamOptions.stream;
  if (streamId === undefined || !STREAM_ID_PATTERN.test(streamId)) {
    throw new StreamConfigError(
      "invalid",
      "A valid --stream <id> is required (1-64 chars [a-zA-Z0-9_-]).",
    );
  }
  const result = await stopStreamWatch(streamId);
  if (result === undefined) {
    ctx.stdout.write(`stream watch is not running for "${streamId}".\n`);
    return 1;
  }
  if (!result) {
    ctx.stderr.write(
      `stop signal sent but watch process (see ${watchPidFilePath(streamId)}) did not exit in time.\n`,
    );
    return 1;
  }
  ctx.stdout.write(`stream watch for "${streamId}" stopped.\n`);
  return 0;
}

async function runStreamList(
  ctx: RunContext,
  streamOptions: StreamCommandOptions,
  env: NodeJS.ProcessEnv,
  options: GlobalOptions,
): Promise<number> {
  const configPath = resolveStreamConfigPath(streamOptions.config, env);
  const views = (await loadStreamConfig(configPath)).streams.map(redactedStreamView);
  if (options.json) {
    ctx.stdout.write(`${JSON.stringify(views)}\n`);
    return 0;
  }
  if (views.length === 0) {
    ctx.stdout.write(`No streams configured (${configPath}).\n`);
    return 0;
  }
  for (const view of views) {
    ctx.stdout.write(
      [
        view.id,
        view.title ?? "-",
        view.urlRedacted,
        `transport=${view.transport}`,
        `segment=${view.segmentSeconds}s`,
        view.enabled ? "enabled" : "disabled",
      ].join("\t") + "\n",
    );
  }
  return 0;
}

async function runStreamEvents(
  ctx: RunContext,
  options: GlobalOptions,
  streamOptions: StreamCommandOptions,
  deps: StreamCommandDependencies,
): Promise<number> {
  const streamId = streamOptions.stream;
  if (streamId === undefined || !STREAM_ID_PATTERN.test(streamId)) {
    throw new StreamConfigError(
      "invalid",
      "A valid --stream <id> is required (1-64 chars [a-zA-Z0-9_-]).",
    );
  }
  const store = createStreamAlertStore({ alertStoreDir: resolveAlertStoreDir(), streamId });
  const emitRows = (rows: readonly StreamAlertRow[]): void => {
    if (options.json) {
      for (const row of rows) ctx.stdout.write(`${JSON.stringify(row)}\n`);
      return;
    }
    for (const row of rows) {
      ctx.stdout.write(
        [
          new Date(row.ts).toISOString(),
          row.kind,
          row.status,
          row.severity ?? "-",
          row.segmentSeq !== undefined ? `seg=${row.segmentSeq}` : "-",
          row.reason ?? "",
        ].join("\t") + "\n",
      );
    }
  };

  const parseBound = (raw: string | undefined): number | undefined =>
    raw === undefined ? undefined : /^\d+$/u.test(raw) ? Number(raw) : Date.parse(raw);
  const since = parseBound(streamOptions.since);
  const until = parseBound(streamOptions.until);
  const limit =
    streamOptions.limit !== undefined &&
    Number.isInteger(streamOptions.limit) &&
    streamOptions.limit > 0
      ? streamOptions.limit
      : undefined;
  const status = streamOptions.status;

  if (streamOptions.follow !== true) {
    emitRows(await store.query({ since, until, status, limit }));
    return 0;
  }
  // follow：轮询增量输出（append-only 观测流，无服务端推送）。
  const now = deps.now ?? Date.now;
  let lastTs = since ?? now();
  const seen = new Set<string>();
  for (;;) {
    const rows = await store.query({ since: lastTs, until, status, limit });
    const fresh = rows.filter((row) => {
      const key = `${row.ts}:${row.kind}:${row.status}:${row.segmentSeq ?? ""}`;
      if (row.ts <= lastTs && seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    emitRows(fresh);
    for (const row of fresh) lastTs = Math.max(lastTs, row.ts);
    await new Promise((resolve) => setTimeout(resolve, EVENTS_FOLLOW_POLL_INTERVAL_MS));
  }
}
