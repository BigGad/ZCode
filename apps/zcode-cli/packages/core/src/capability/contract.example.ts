/**
 * 能力积木层的标准调用示例：业务靠模仿写代码，这里放的就是该模仿的那份。
 *
 * ⚠️ 这一层是**纯逻辑**：读文件、算指纹、落盘都在调用方（命令面 / adapter），
 * 这里只把「已经读好的东西」变成 sidecar。
 */
import {
  buildOcrSidecar,
  evaluateOcrSidecarCache,
  type OcrSidecarBuildInput,
  type OcrSidecarCacheCriteria,
} from "./index.js";

/** 一次典型的解析：先判缓存，没命中才组装 sidecar。 */
export function exampleBuildSidecar(
  input: OcrSidecarBuildInput,
  criteria: OcrSidecarCacheCriteria,
): { readonly cached: boolean; readonly sidecar?: ReturnType<typeof buildOcrSidecar> } {
  const decision = evaluateOcrSidecarCache(undefined, criteria);
  if (decision.hit) return { cached: true };
  return { cached: false, sidecar: buildOcrSidecar(input) };
}
