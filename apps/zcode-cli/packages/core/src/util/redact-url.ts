/**
 * URL 凭据脱敏工具——单一实现下沉在 @zcode/contracts（network/redact-url.ts），
 * 此处 re-export 保持 core 内 import 路径稳定（webfetch-url.ts 从这里转发）。
 */
export { redactUrlCredentials, redactUrlString } from "@zcode/contracts";
