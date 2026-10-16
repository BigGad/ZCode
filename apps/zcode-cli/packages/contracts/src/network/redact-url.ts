/**
 * URL 凭据脱敏工具（2026-10-16 新增，随 stream 域引入）。
 *
 * stream 全链路（CLI 输出、日志、alert JSONL、错误消息、事件 payload）
 * 只允许出现脱敏 URL（stream-input.md 凭据管理节）。放在 contracts 使
 * core / adapters / cli 三层共用同一实现，避免各自复制正则。
 */

/** 已解析 URL 的凭据清除。 */
export function redactUrlCredentials(url: URL): string {
  const clone = new URL(url);
  clone.username = "";
  clone.password = "";
  return clone.toString();
}

/**
 * 任意出现位置的 `scheme://userinfo@` 剥除（g 全局：reason 等自由文本可能内嵌
 * URL，不能只锚定字符串开头）；userinfo 不含 @/?#，与 WHATWG 解析规则一致。
 */
const USERINFO_PATTERN = /(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?<userinfo>[^@/?#]*)@/gu;

/**
 * 字符串形态的凭据脱敏，用于任意 scheme（rtsp:// 等）与解析失败回退。
 * - 可解析：走 URL 凭据清除。
 * - 不可解析（或 URL 内嵌在自由文本中）：正则剥除所有 `user:pass@`，保留
 *   scheme 与其余部分。
 * - 两者都不满足：原样返回（无凭据形态）。
 */
export function redactUrlString(raw: string): string {
  return raw.replace(USERINFO_PATTERN, "$1");
}
