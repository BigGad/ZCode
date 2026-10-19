import { SessionEventType, type SessionEvent } from "@zcode/contracts";

/**
 * `zcode recognize` 的实时进度翻译器（image-recognition-cli.md「Concurrency & Ordering」/
 * 「Output Formats」节）。纯函数式：只把会话事件翻成 `RecognizeProgressLine`，
 * 写哪里由调用方决定（stderr 文本行 / stdout NDJSON），自己不持有 plan、不碰 IO。
 *
 * 事件来源有两条，因为子代理的实时正文不在父会话里：
 *  - `SubagentSpawned` / `SubagentStopped` 由 runner 以**父** sessionId 发出，载荷带
 *    `childSessionId` 与 `parentToolCallId`；
 *  - 子代理自己的流式正文以 runner 另铸的**子** sessionId（`sess_subagent_<agentId>`）出现：
 *    `subagent.ts` 的 `eventSink` 把 child runtime 的原始事件原样扇出到父 runtime 的外部
 *    sink，所以同一个订阅里能同时看到父子两侧。
 *
 * `SubagentMessage` 类型已定义但当前 core 未从该路径 emit（spec §10.5），因此 `message` 行
 * 只认 `ModelStreaming` 的 `text_delta`。
 */

export type RecognizeProgressStage = "started" | "message" | "stopped";

export interface RecognizeProgressLine {
  /** 0-based，与 plan 里的图片顺序一致。 */
  index: number;
  /** `image-1`：给人读的稳定短标签。 */
  subagentId: string;
  /** `a3f`：trace 关联句柄，同一批次内每个子代理不同。 */
  shortId: string;
  stage: RecognizeProgressStage;
  /** 仅 `message`：累积正文的单行预览（已截断）。 */
  preview?: string;
  /** 仅 `stopped`。 */
  outcome?: "ok" | "error";
  durationMs?: number;
  error?: string;
}

/**
 * 单个子代理的身份，由 `recognize-signer` 合成，progress 只做索引映射。
 *
 * 两个归并键对应两条不同的事件路径，不能互换（运行时证据见
 * `core/src/subagent/runner.ts` 的 `createSubagentLifecycle` / `runExploreAgent` 调用）：
 *  - `parentToolCallId` 是派发时合成的调用 id，`SubagentSpawned` / `SubagentStopped`
 *    载荷里带的就是它；
 *  - 子会话流式事件（`ModelStreaming`）的 `event.sessionId` 是 runner **另铸**的
 *    `sess_subagent_<agentId>`，不是派发请求里传入的 `runtimeSessionId`——runner 无视
 *    `request.sessionId`，一律用 `lifecycle.childSessionId` 建子 runtime。所以流式归并键
 *    只能在收到 `SubagentSpawned`（载荷带 `childSessionId`）后学到，不能预先合成。
 */
export interface RecognizeProgressIdentity {
  index: number;
  subagentId: string;
  shortId: string;
  /** 派发请求里填的期望会话 id；runner 会另铸子会话事实 id，进度归并不使用它。 */
  runtimeSessionId: string;
  parentToolCallId: string;
}

export interface RecognizeProgressReporterInput {
  identities: readonly RecognizeProgressIdentity[];
  emit: (line: RecognizeProgressLine) => void;
  /** 注入时钟，让节流可被无睡眠单测穷举（与 headless-workflow 的 `now()` 注入同款）。 */
  now?: () => number;
  throttleMs?: number;
}

/**
 * `message` 行的最小间隔。started / stopped 是每个子代理的相位端点，任何节流都不得吃掉
 * 它们——否则一张图可能整段静默，然后突然出现在结果里。与 `headless-workflow.ts` 的
 * `isUnthrottledProgress` 同一判据。
 */
const DEFAULT_PROGRESS_THROTTLE_MS = 250;

/** 预览是给人扫的，不是给机器读的：单行 + 截断。完整正文在最终结果里。 */
const PREVIEW_MAX_CHARS = 80;

export function createRecognizeProgressReporter(
  input: RecognizeProgressReporterInput,
): (event: SessionEvent) => void {
  const now = input.now ?? Date.now;
  const throttleMs = input.throttleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;

  const byChildSessionId = new Map<string, RecognizeProgressIdentity>();
  const byParentToolCallId = new Map<string, RecognizeProgressIdentity>();
  for (const identity of input.identities) {
    byParentToolCallId.set(identity.parentToolCallId, identity);
  }

  const accumulated = new Map<number, string>();
  const lastMessageAt = new Map<number, number>();

  const previewOf = (index: number): string => {
    const text = (accumulated.get(index) ?? "").replace(/\s+/gu, " ").trim();
    return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
  };

  return (event) => {
    if (event.type === SessionEventType.SubagentSpawned) {
      const payload = asRecord(event.payload);
      const identity = byParentToolCallId.get(String(payload.parentToolCallId ?? ""));
      if (identity === undefined) return;
      // 流式事件以 runner 另铸的子会话 id 为 sessionId（见 RecognizeProgressIdentity 注释），
      // 这里是唯一能拿到它的时机；先登记再发 started，保证后续 text_delta 不会扑空。
      const childSessionId = payload.childSessionId;
      if (typeof childSessionId === "string" && childSessionId.length > 0) {
        byChildSessionId.set(childSessionId, identity);
      }
      input.emit({
        index: identity.index,
        subagentId: identity.subagentId,
        shortId: identity.shortId,
        stage: "started",
      });
      return;
    }

    if (event.type === SessionEventType.SubagentStopped) {
      const payload = asRecord(event.payload);
      const identity = byParentToolCallId.get(String(payload.parentToolCallId ?? ""));
      if (identity === undefined) return;
      const childSessionId = payload.childSessionId;
      if (typeof childSessionId === "string") byChildSessionId.delete(childSessionId);
      const status = payload.status;
      const outcome = status === "completed" ? "ok" : "error";
      const durationMs = typeof payload.totalDurationMs === "number" ? payload.totalDurationMs : undefined;
      const error = typeof payload.error === "string" ? payload.error : undefined;
      input.emit({
        index: identity.index,
        subagentId: identity.subagentId,
        shortId: identity.shortId,
        stage: "stopped",
        outcome,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(error === undefined ? {} : { error }),
      });
      return;
    }

    // 子代理自己的流式正文：按 runner 铸的子会话 id 归属，只认 text_delta。
    const identity = byChildSessionId.get(String(event.sessionId));
    if (identity === undefined) return;
    if (event.type !== SessionEventType.ModelStreaming) return;
    const payload = asRecord(event.payload);
    if (payload.kind !== "text_delta" || typeof payload.delta !== "string") return;

    accumulated.set(identity.index, `${accumulated.get(identity.index) ?? ""}${payload.delta}`);
    const at = now();
    const previous = lastMessageAt.get(identity.index);
    if (previous !== undefined && at - previous < throttleMs) return;
    lastMessageAt.set(identity.index, at);
    input.emit({
      index: identity.index,
      subagentId: identity.subagentId,
      shortId: identity.shortId,
      stage: "message",
      preview: previewOf(identity.index),
    });
  };
}

/** `[01/24 image-1 a3f] started` —— text 模式给 operator 扫的 stderr 行。 */
export function formatRecognizeProgressLine(
  line: RecognizeProgressLine,
  total: number,
): string {
  const ordinal = String(line.index + 1).padStart(String(total).length, "0");
  const head = `[${ordinal}/${total} ${line.subagentId} ${line.shortId}]`;
  switch (line.stage) {
    case "started":
      return `${head} started\n`;
    case "message":
      return `${head} message   "${line.preview ?? ""}"\n`;
    case "stopped": {
      const seconds = `${((line.durationMs ?? 0) / 1000).toFixed(1)}s`;
      if (line.outcome === "error") {
        return `${head} stopped   FAIL ${seconds}${line.error ? ` ${line.error}` : ""}\n`;
      }
      return `${head} stopped   ok ${seconds}\n`;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
