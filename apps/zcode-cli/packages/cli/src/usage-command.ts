import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { SessionId, UsageRecordsQueryInput } from "@zcode/contracts";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";

const DAY_MS = 86_400_000;
/** 未指定 --since 时的统计窗口；受 30 天保留期（USAGE_RETENTION_DAYS）约束。 */
const DEFAULT_WINDOW_DAYS = 7;
/** 导出缺省行数上限，与 adapters 侧 USAGE_RECORDS_DEFAULT_LIMIT 一致。 */
const DEFAULT_EXPORT_LIMIT = 10_000;

export interface UsageCommandOptions {
  agent?: string;
  json?: boolean;
  limit?: number;
  session?: string;
  sessions?: boolean;
  since?: string;
  tools?: boolean;
  until?: string;
}

/** 命令实际依赖的 store 切面；真实 SqliteSessionStore 与测试注入都满足它。 */
type UsageStoreHandle = Pick<
  ReturnType<typeof createSqliteSessionStore>,
  | "close"
  | "queryModelUsageRecords"
  | "queryToolUsageRecords"
  | "getSession"
  | "listSessions"
  | "messages"
>;

/** 测试注入点：默认打开真实默认路径的 SqliteSessionStore。 */
export interface UsageCommandDependencies {
  createSessionStore?: () => UsageStoreHandle;
}

/**
 * `zcode usage` —— 用量统计导出（统计/LLM 分析通道）。
 *
 * 数据边界（usage-observability.md）：统计行不含 prompt / 工具输入输出全文；
 * 会话内容（每个 agent 调用的输入与输出）在会话转写里，用 `--session <id>`
 * 导出该会话全部消息（子 agent 会话有独立 sessionID，可在 --json 明细里按
 * querySource=subagent 找到）。数据保留 30 天，早于窗口的行已被清理。
 */
export async function runUsageCommand(
  ctx: RunContext,
  options: GlobalOptions,
  usageOptions: UsageCommandOptions,
  deps: UsageCommandDependencies = {},
): Promise<number> {
  if (
    usageOptions.limit !== undefined &&
    (!Number.isInteger(usageOptions.limit) || usageOptions.limit <= 0)
  ) {
    throw new Error(`Invalid --limit: ${usageOptions.limit}. Use a positive integer.`);
  }
  const now = Date.now();
  let since = parseTimeBound(usageOptions.since, now);
  const until = parseTimeBound(usageOptions.until, now);
  if (usageOptions.since === undefined) {
    since = now - DEFAULT_WINDOW_DAYS * DAY_MS;
  }

  const store = deps.createSessionStore?.() ?? createSqliteSessionStore();
  try {
    if (usageOptions.sessions) {
      return await exportSessionList(ctx, options, store, { since, until });
    }
    if (usageOptions.session !== undefined) {
      return await exportSessionTranscript(ctx, options, store, usageOptions.session);
    }
    return await exportUsageRecords(ctx, options, store, usageOptions, { since, until });
  } finally {
    store.close();
  }
}

function parseTimeBound(raw: string | undefined, now: number): number | undefined {
  if (raw === undefined) return undefined;
  const relativeDays = /^(\d+)d$/.exec(raw);
  if (relativeDays) return now - Number(relativeDays[1]) * DAY_MS;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date: ${raw}. Use "Nd", unix ms, or an ISO date string.`);
  }
  return parsed;
}

/** 命令实际依赖的 store 切面；真实 SqliteSessionStore 与测试注入都满足它。 */
type UsageStore = UsageStoreHandle;

async function exportUsageRecords(
  ctx: RunContext,
  options: GlobalOptions,
  store: UsageStore,
  usageOptions: UsageCommandOptions,
  window: { since?: number; until?: number },
): Promise<number> {
  const effectiveLimit = usageOptions.limit ?? DEFAULT_EXPORT_LIMIT;
  const query: UsageRecordsQueryInput = {
    ...(window.since !== undefined ? { since: window.since } : {}),
    ...(window.until !== undefined ? { until: window.until } : {}),
    ...(usageOptions.agent !== undefined ? { agent: usageOptions.agent } : {}),
    limit: effectiveLimit,
  };
  const modelRows = await store.queryModelUsageRecords(query);
  const toolRows = usageOptions.tools ? await store.queryToolUsageRecords(query) : [];

  if (options.json) {
    writeNdjson(ctx, {
      kind: "meta",
      generatedAt: new Date().toISOString(),
      window: { since: window.since, until: window.until },
      // 达到上限说明窗口内还有未导出的行，消费方应加大 --limit 或缩小窗口。
      truncated: modelRows.length >= effectiveLimit || toolRows.length >= effectiveLimit,
    });
    for (const row of modelRows) writeNdjson(ctx, { kind: "model_request", ...row });
    for (const row of toolRows) writeNdjson(ctx, { kind: "tool_call", ...row });
    return 0;
  }

  writeSummary(ctx, modelRows, toolRows, window);
  return 0;
}

function writeSummary(
  ctx: RunContext,
  modelRows: Awaited<ReturnType<UsageStore["queryModelUsageRecords"]>>,
  toolRows: Awaited<ReturnType<UsageStore["queryToolUsageRecords"]>>,
  window: { since?: number; until?: number },
): void {
  const totalTokens = sum(modelRows, (row) => row.computedTotalTokens);
  const inputTokens = sum(modelRows, (row) => row.inputTokens);
  const outputTokens = sum(modelRows, (row) => row.outputTokens);
  const cacheReadTokens = sum(modelRows, (row) => row.cacheReadInputTokens);
  const cacheWriteTokens = sum(modelRows, (row) => row.cacheCreationInputTokens);
  const errors = modelRows.filter((row) => row.status === "error").length;

  ctx.stdout.write(`zcode usage (${formatBound(window.since)} .. ${formatBound(window.until)})\n`);
  ctx.stdout.write(
    `model requests: ${modelRows.length} (errors: ${errors})\n` +
      `tokens: total ${totalTokens} | input ${inputTokens} | output ${outputTokens} | ` +
      `cache read ${cacheReadTokens} | cache write ${cacheWriteTokens}\n`,
  );

  ctx.stdout.write(`\nby model:\n`);
  for (const [modelId, rows] of groupBy(modelRows, (row) => row.modelId)) {
    ctx.stdout.write(
      `  ${modelId}: ${rows.length} requests, ${sum(rows, (row) => row.computedTotalTokens)} tokens\n`,
    );
  }

  ctx.stdout.write(`\nby agent (querySource):\n`);
  for (const [key, rows] of groupBy(modelRows, (row) => `${row.agent ?? "-"} (${row.querySource})`)) {
    ctx.stdout.write(
      `  ${key}: ${rows.length} requests, ${sum(rows, (row) => row.computedTotalTokens)} tokens, ` +
        `sessions: ${new Set(rows.map((row) => row.sessionID)).size}\n`,
    );
  }

  if (toolRows.length > 0) {
    ctx.stdout.write(`\nby tool:\n`);
    for (const [toolName, rows] of groupBy(toolRows, (row) => row.toolName)) {
      ctx.stdout.write(
        `  ${toolName}: ${rows.length} calls, errors: ${rows.filter((row) => row.status === "error").length}\n`,
      );
    }
  }

  ctx.stdout.write(
    `\nsessions (subagent calls have their own sessionID; dump content with --session <id>):\n`,
  );
  for (const [sessionId, rows] of groupBy(modelRows, (row) => row.sessionID)) {
    const agents = [...new Set(rows.map((row) => row.agent ?? "-"))].join(",");
    ctx.stdout.write(`  ${sessionId} [${agents}] ${sum(rows, (row) => row.computedTotalTokens)} tokens\n`);
  }
  ctx.stdout.write(`\nretention: usage rows are pruned after 30 days\n`);
}

async function exportSessionList(
  ctx: RunContext,
  options: GlobalOptions,
  store: UsageStore,
  window: { since?: number; until?: number },
): Promise<number> {
  const sessions = await store.listSessions();
  const filtered = sessions
    .filter((session) => window.since === undefined || session.time.updated >= window.since)
    .filter((session) => window.until === undefined || session.time.updated <= window.until)
    .sort((a, b) => a.time.updated - b.time.updated);
  if (options.json) {
    for (const session of filtered) {
      writeNdjson(ctx, {
        kind: "session",
        id: session.id,
        parentID: session.parentID,
        title: session.title,
        taskType: session.taskType,
        time: session.time,
      });
    }
    return 0;
  }
  for (const session of filtered) {
    ctx.stdout.write(
      `${session.id}\t${session.parentID ? `[child of ${session.parentID}]` : "[root]"}\t` +
        `${new Date(session.time.updated).toISOString()}\t${session.title}\n`,
    );
  }
  return 0;
}

async function exportSessionTranscript(
  ctx: RunContext,
  options: GlobalOptions,
  store: UsageStore,
  sessionID: string,
): Promise<number> {
  const session = await store.getSession(sessionID as SessionId);
  if (!session) {
    ctx.stderr.write(`session not found: ${sessionID}\n`);
    return 1;
  }
  const messages = await store.messages({ sessionID: session.id });
  if (options.json) {
    writeNdjson(ctx, {
      kind: "session_meta",
      id: session.id,
      parentID: session.parentID,
      title: session.title,
      taskType: session.taskType,
      time: session.time,
    });
    for (const message of messages) {
      writeNdjson(ctx, { kind: "message", message: message.info, parts: message.parts });
    }
    return 0;
  }
  // 文本模式只渲染消息文本，避免把工具载荷整段刷到终端。
  for (const message of messages) {
    const role = message.info.role;
    const text = message.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.length > 0) {
      ctx.stdout.write(`--- ${role} ${message.info.id} ---\n${text}\n`);
    }
  }
  return 0;
}

function writeNdjson(ctx: RunContext, value: unknown): void {
  ctx.stdout.write(`${JSON.stringify(value)}\n`);
}

function formatBound(bound: number | undefined): string {
  return bound === undefined ? "..." : new Date(bound).toISOString();
}

function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) group.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}
