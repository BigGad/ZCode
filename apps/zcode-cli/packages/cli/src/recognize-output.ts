import type { GlobalOutputFormat, JsonValue } from "@zcode/shared-types";
import type { RecognizeProgressLine } from "./recognize-progress.js";
import type { RecognizeMode, RecognizeResult } from "./recognize-schema.js";

/**
 * `zcode recognize` 的输出契约（image-recognition-cli.md「Output Formats」节）。
 *
 * 三种格式共用同一批对象，只有信封不同：
 *  - `text`：stdout 三段（Plan / Results / Summary），stderr 实时进度；
 *  - `json`：stdout 一个 `{ plan, results, summary }`，stderr 仍写实时进度；
 *  - `stream-json`：stdout NDJSON（plan → progress×N → result），stderr 不写进度，避免双写。
 *
 * 展示路径按 folder 归一化成相对路径，绝对路径只在 `absolutePath` 字段里出现——operator 读的是
 * 「哪张图」，机器需要的是可再定位的绝对路径，两者不混在同一个字段里。
 */

export interface RecognizePlan {
  folder: string;
  totalImages: number;
  byExtension: Record<string, number>;
  model: string;
  schema: RecognizeMode;
  maxConcurrency: number;
  recursive: boolean;
  fields?: string[];
  questions?: string[];
  estimatedSubagents: number;
}

export interface RecognizeFinalItem {
  index: number;
  /** 相对 folder 的展示路径。 */
  image: string;
  absolutePath: string;
  status: "success" | "error";
  durationMs: number;
  result: RecognizeResult;
}

export interface RecognizeSummary {
  total: number;
  succeeded: number;
  failed: number;
  totalDurationMs: number;
}

/** stream-json 里的一行进度。`at` 是事件被翻译出来的时刻，用于消费者排序/节流复核。 */
interface RecognizeProgressStreamLine {
  type: "progress";
  subagentId: string;
  index: number;
  shortId: string;
  stage: RecognizeProgressLine["stage"];
  at: number;
  preview?: string;
  outcome?: "ok" | "error";
  durationMs?: number;
  error?: string;
  /** 第几次派发（接地重试会 >1，见 spec §5.1）。 */
  attempt?: number;
}

export function progressStreamLine(line: RecognizeProgressLine, at: number): JsonValue {
  const payload: RecognizeProgressStreamLine = {
    type: "progress",
    subagentId: line.subagentId,
    index: line.index,
    shortId: line.shortId,
    stage: line.stage,
    at,
    ...(line.preview === undefined ? {} : { preview: line.preview }),
    ...(line.outcome === undefined ? {} : { outcome: line.outcome }),
    ...(line.durationMs === undefined ? {} : { durationMs: line.durationMs }),
    ...(line.error === undefined ? {} : { error: line.error }),
    ...(line.attempt === undefined ? {} : { attempt: line.attempt }),
  };
  return payload as unknown as JsonValue;
}

/** `ok` 行给人看的一行摘要：只取该 mode 的主载荷，不打印整段 JSON。 */
export function summarizeResultForDisplay(result: RecognizeResult): string {
  if (result.status === "error") {
    return `FAIL  ${result.reason}: ${result.message}`;
  }
  if ("description" in result) return `ok    "${truncate(result.description)}"`;
  if ("answers" in result) return `ok    "${truncate(result.answers.map((a) => a.a).join(" / "))}"`;
  return `ok    ${truncate(JSON.stringify(result.fields))}`;
}

export interface RecognizeWriters {
  /** 结果与 plan 走 stdout。 */
  out: (line: string) => void;
  /** 进度走 stderr。 */
  err: (line: string) => void;
}

export function writePlan(
  writers: RecognizeWriters,
  format: GlobalOutputFormat,
  plan: RecognizePlan,
): void {
  if (format === "stream-json") {
    writers.out(`${JSON.stringify({ type: "plan", plan })}\n`);
    return;
  }
  if (format === "json") return; // json 模式在末尾一次性打印整个文档。
  writers.out(
    [
      "Plan:",
      `  folder:              ${plan.folder}`,
      `  total_images:        ${plan.totalImages}`,
      `  by_extension:        ${formatExtensionCounts(plan.byExtension)}`,
      `  model:               ${plan.model}`,
      `  schema:              ${plan.schema}`,
      `  max_concurrency:     ${plan.maxConcurrency}`,
      `  recursive:           ${plan.recursive}`,
      ...(plan.fields ? [`  fields:              ${plan.fields.join(", ")}`] : []),
      ...(plan.questions ? [`  questions:           ${plan.questions.length}`] : []),
      `  estimated_subagents: ${plan.estimatedSubagents}`,
      "---",
      "",
    ].join("\n") + "\n",
  );
}

export function writeResult(
  writers: RecognizeWriters,
  format: GlobalOutputFormat,
  input: {
    plan: RecognizePlan;
    results: readonly RecognizeFinalItem[];
    summary: RecognizeSummary;
  },
): void {
  if (format === "stream-json") {
    writers.out(
      `${JSON.stringify({ type: "result", results: input.results, summary: input.summary })}\n`,
    );
    return;
  }
  if (format === "json") {
    writers.out(
      `${JSON.stringify({ plan: input.plan, results: input.results, summary: input.summary }, null, 2)}\n`,
    );
    return;
  }

  const width = String(input.results.length).length;
  writers.out(`Results (${input.results.length}):\n`);
  for (const item of input.results) {
    const ordinal = String(item.index + 1).padStart(width, "0");
    const seconds = `${(item.durationMs / 1000).toFixed(1)}s`;
    const tail = item.status === "success" ? `(${seconds})` : "";
    writers.out(
      `  [${ordinal}/${input.results.length}] ${item.image}  ${summarizeResultForDisplay(item.result)} ${tail}\n`.replace(
        /\s+\n$/u,
        "\n",
      ),
    );
  }
  writers.out(
    [
      "",
      "Summary:",
      `  succeeded: ${input.summary.succeeded}   failed: ${input.summary.failed}   totalDurationMs: ${input.summary.totalDurationMs}`,
      "",
    ].join("\n"),
  );
}

function formatExtensionCounts(byExtension: Record<string, number>): string {
  const entries = Object.entries(byExtension).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "-";
  return entries.map(([extension, count]) => `${extension}=${count}`).join("  ");
}

const DISPLAY_MAX_CHARS = 72;

function truncate(text: string): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length > DISPLAY_MAX_CHARS ? `${single.slice(0, DISPLAY_MAX_CHARS)}…` : single;
}
