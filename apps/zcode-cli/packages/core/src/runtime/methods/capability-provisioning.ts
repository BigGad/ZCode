import type { AgentRuntimeInternal } from "../internal.js";
import type { LocalInfraProvisioning } from "../helpers/capability-provisioning/index.js";
import { resolveLocalInfraReadiness } from "../helpers/capability-provisioning/index.js";

/**
 * 装配能力供给层的输入（spec：docs/design/v2/capability-provisioning.md §8.3）。
 *
 * ⚠️ **端口缺席 ⇒ undefined** ⇒ 附件链不做能力供给（既有行为不变），不报错。
 * ⚠️ **就绪状态按轮缓存**：探测会 spawn 子进程（`hardware detect` + `models show`），
 * 同一轮任务里只付一次；跨轮不缓存（环境会变）。
 */
export function resolveLocalInfraProvisioning(
  runtime: AgentRuntimeInternal,
  turnId: string,
): LocalInfraProvisioning | undefined {
  const port = runtime.localInfraPort;
  if (port === undefined) return undefined;
  return {
    port,
    degradation: runtime.localInfraDegradation,
    // ⚠️ **默认开**（第 2 步，D12）：端口装配了就允许自动备资产；
    // 关掉只能靠配置 `ocr.autoProvision: false`（装配层已经读好了）。
    autoProvision: runtime.localInfraAutoProvision ?? true,
    resolveReadiness: () =>
      resolveLocalInfraReadiness({
        cache: runtime.localInfraReadinessCache,
        turnId,
        port,
      }),
  };
}
