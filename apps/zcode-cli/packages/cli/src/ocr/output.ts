import type {
  CapabilityEnvelope,
  CapabilityProgressEvent,
  CapabilityProgressPhase,
} from "@zcode/contracts";
import { exitCodeForCapabilityError } from "@zcode/core";

/**
 * `zcode ocr` 的输出通道（spec：docs/design/v2/capability-cli-blocks.md §5）。
 *
 * ⚠️ **stdout 恒为单个 JSON 对象**（`--json` 时），进度与告警只走 stderr ——
 * MinerU 自己的 stdout 是人读文本（`已解析 1 个输入。`），**不得当 JSON 解析**。
 */

/** 退出码：成功。 */
export const OCR_EXIT_OK = 0;
/** 退出码：参数非法 / 文件不存在 / 引擎不可用 / 执行失败 / 产物缺失。 */
export const OCR_EXIT_ERROR = 1;
/** 退出码：超时（与 `capability-registry.md` §7 的能力退出码表同源）。 */
export const OCR_EXIT_TIMEOUT = 124;
/** 退出码：取消。 */
export const OCR_EXIT_CANCELLED = 130;

export interface OcrContext {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

/**
 * 写信封到 stdout。
 *
 * ⚠️ **`--json` 时 stdout 只有这一个 JSON 对象** —— 业务 `JSON.parse(stdout)` 即可。
 */
export function writeEnvelope(ctx: OcrContext, envelope: CapabilityEnvelope): void {
  ctx.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

/**
 * 进度与错误的上报通道（spec §5.6）。
 *
 * ⚠️ **`--json` 时 stderr 是纯进度流**：每行一个 NDJSON 事件（`{"type":"progress",…}`）。
 * ⚠️ **错误不进 stderr**（JSON 模式）—— 错误只在 stdout 信封里 + 退出码，
 * ⇒ 业务逐行解析 stderr **不会混进非 JSON 行**。
 * ⚠️ **非 `--json` 时 stderr 是人读文本**（进度行 + 末尾一行错误）。
 */
export interface OcrReporter {
  /** 进度事件。`percent` 不可知时传 `null`（不许拿假百分比糊弄业务）。 */
  progress(phase: CapabilityProgressPhase, message: string): void;
  /** 错误行。JSON 模式下是 no-op（错误只进信封）。 */
  error(message: string): void;
}

export function createReporter(ctx: OcrContext, json: boolean): OcrReporter {
  return json ? createJsonReporter(ctx) : createTextReporter(ctx);
}

function createJsonReporter(ctx: OcrContext): OcrReporter {
  return {
    progress(phase, message) {
      const event: CapabilityProgressEvent = { type: "progress", phase, message, percent: null };
      ctx.stderr.write(`${JSON.stringify(event)}\n`);
    },
    // ⚠️ JSON 模式：**错误不进 stderr**（spec §5.6）——只在 stdout 信封里。
    error() {},
  };
}

function createTextReporter(ctx: OcrContext): OcrReporter {
  return {
    progress(_phase, message) {
      ctx.stderr.write(`${message}\n`);
    },
    error(message) {
      ctx.stderr.write(`${message}\n`);
    },
  };
}

/** 信封对应的退出码（spec §5.2）。 */
export function exitCodeForEnvelope(envelope: CapabilityEnvelope): number {
  return envelope.ok ? OCR_EXIT_OK : exitCodeForCapabilityError(envelope.error.code);
}

/**
 * 写信封（`--json`）或人读报告，并返回退出码。
 *
 * ⚠️ **人读报告由调用方给** —— `inspect` 与 `parse` 的报告形状不同（页成分 vs 产物引用）。
 */
export function emitEnvelope(
  ctx: OcrContext,
  json: boolean,
  envelope: CapabilityEnvelope,
  writeTextReport: (envelope: CapabilityEnvelope) => string,
): number {
  if (json) {
    writeEnvelope(ctx, envelope);
  } else {
    ctx.stdout.write(writeTextReport(envelope));
  }
  return exitCodeForEnvelope(envelope);
}
