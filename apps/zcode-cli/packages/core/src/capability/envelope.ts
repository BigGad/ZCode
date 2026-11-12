// ============================================================
// 统一信封 —— 积木对外唯一的输出形状
// ============================================================

import {
  CAPABILITY_ENVELOPE_VERSION,
  CAPABILITY_EXIT_CODES,
  type CapabilityBlockId,
  type CapabilityEnvelopeError,
  type CapabilityEnvelopeMetrics,
  type CapabilityErrorCode,
  type CapabilityFailureEnvelope,
  type CapabilitySuccessEnvelope,
  type LocalInfraError,
} from "@zcode/contracts";

/**
 * 成功信封。
 *
 * ⚠️ `output` 只放**产物引用**，产物本体在磁盘上 —— 业务要的是文件，不是塞进 stdout 的一大坨 JSON。
 */
export function buildSuccessEnvelope(
  key: CapabilityBlockId,
  output: Readonly<Record<string, unknown>>,
  metrics?: CapabilityEnvelopeMetrics,
): CapabilitySuccessEnvelope {
  return {
    version: CAPABILITY_ENVELOPE_VERSION,
    key,
    ok: true,
    output,
    ...(metrics !== undefined ? { metrics } : {}),
  };
}

/** 失败信封。 */
export function buildFailureEnvelope(
  key: CapabilityBlockId,
  error: CapabilityEnvelopeError,
  metrics?: CapabilityEnvelopeMetrics,
): CapabilityFailureEnvelope {
  return {
    version: CAPABILITY_ENVELOPE_VERSION,
    key,
    ok: false,
    error,
    ...(metrics !== undefined ? { metrics } : {}),
  };
}

/**
 * 引擎内部码 → 对外能力码（**单向归一**，spec §5.2）。
 *
 * ⚠️ 对外只有 8 个能力码；引擎的细粒度码放在 `details.engineCode` ——
 * 业务按能力码分支，运维按内部码定位。
 */
export function normalizeLocalInfraError(error: LocalInfraError): CapabilityEnvelopeError {
  return {
    code: capabilityErrorCodeFor(error),
    message: error.message,
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    details: { ...error.details, engineCode: error.code },
  };
}

/** 内部码到能力码的映射表（**穷举**，不留兜底分支）。 */
function capabilityErrorCodeFor(error: LocalInfraError): CapabilityErrorCode {
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
      // 文件不存在 → not_found；类型不支持 → unsupported_input。
      return error.details?.reason === "unsupported_input" ? "unsupported_input" : "not_found";
    case "password_protected":
      // 加密 PDF：密码被拒或压根没给 ⇒ 输入本身不满足解析前提，不是引擎故障。
      return "invalid_input";
    case "document_corrupted":
      // 文档坏了 ⇒ 输入不合法（**不是** not_found —— 文件在，只是读不出内容）。
      return "invalid_input";
    case "permission_denied":
      return "permission_denied";
  }
}

/** 能力码 → 退出码（spec §5.2）。 */
export function exitCodeForCapabilityError(code: CapabilityErrorCode): number {
  switch (code) {
    case "timeout":
      return CAPABILITY_EXIT_CODES.timeout;
    case "cancelled":
      return CAPABILITY_EXIT_CODES.cancelled;
    default:
      return CAPABILITY_EXIT_CODES.error;
  }
}
