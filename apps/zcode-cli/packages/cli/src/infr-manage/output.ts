import type { LocalInfraError } from "@zcode/contracts";

/** 退出码：成功。 */
export const INFR_EXIT_OK = 0;
/** 退出码：参数非法 / 文件不存在 / 引擎不可用 / 执行失败 / 产物缺失。 */
export const INFR_EXIT_ERROR = 1;
/** 退出码：超时（与 `capability-registry.md` §7 的能力退出码表同源）。 */
export const INFR_EXIT_TIMEOUT = 124;

/**
 * `zcode-infr-manage` 的输出通道。
 *
 * ⚠️ **stdout 恒为单个 JSON 对象**（`--json` 时），进度与告警只走 stderr ——
 * MinerU 自己的 stdout 是人读文本（`已解析 1 个输入。`），**不得当 JSON 解析**。
 */
export interface InfrManageContext {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

export function writeJson(ctx: InfrManageContext, value: unknown): void {
  ctx.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 内部码 → 对外归一的能力码（spec §7.6）。
 *
 * ⚠️ `error.code` 对外是**归一后的能力码**，内部码放在 `details.engineCode` ——
 * 业务方按能力码分支，运维按内部码定位。
 */
export function normalizeErrorCode(error: LocalInfraError): string {
  switch (error.code) {
    case "engine_not_found":
      return "invalid_input";
    case "engine_unavailable":
      return "unavailable";
    case "process_failed":
      return "internal";
    case "artifact_missing":
      return "internal";
    case "timeout":
      return "timeout";
    case "input_invalid":
      // §7.6：文件不存在 → not_found；类型不支持 → unsupported_input。
      return error.details?.reason === "unsupported_input" ? "unsupported_input" : "not_found";
  }
}

export interface JsonError {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly details: Record<string, unknown>;
}

export function toJsonError(error: LocalInfraError): JsonError {
  return {
    code: normalizeErrorCode(error),
    message: error.message,
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    details: { ...error.details, engineCode: error.code },
  };
}

/** 失败结果对应的退出码。 */
export function exitCodeForError(error: LocalInfraError): number {
  return error.code === "timeout" ? INFR_EXIT_TIMEOUT : INFR_EXIT_ERROR;
}
