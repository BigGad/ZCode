import type { LocalInfraPort, Logger } from "../../deps.js";
import type { LocalOcrFailure } from "./local-ocr.js";

/**
 * 自动备资产（第 2 步，spec：docs/design/v2/capability-provisioning.md §5.2 / §9.2 的第 ②' 步）。
 *
 * ⚠️ **备的是 ③ 层（模型权重），不是引擎二进制**：D5 说得很死 ——
 * 第三方可执行文件不由 ZCode 安装（跨平台矩阵、权限、装坏了不可回滚），
 * 资产（权重 / 语言包）可以由 ZCode 备。
 *
 * ⚠️ **下载走同一个 `LocalInfraPort`**（`downloadModels`）—— 不自己 spawn，
 * 不自己拼命令；端口后面才有子进程。
 *
 * ⚠️ **取消要透传**：自动备资产是**阻塞的**（D13），用户取消任务时，
 * 正在进行的下载必须一起停，否则用户取消后还在偷偷下 1GB。
 */

/** 能自动下载的档位（⚠️ MinerU 的 `models download --tier` 只接受这两档）。 */
export type ProvisionableTier = "basic" | "standard";

export interface LocalAssetProvisionInput {
  readonly port: LocalInfraPort;
  readonly tier: ProvisionableTier;
  /** 下载预算（毫秒）；缺省用端口自己的上限。 */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export interface LocalAssetProvisionSuccess {
  readonly ok: true;
  readonly tier: ProvisionableTier;
  readonly warnings: readonly string[];
}

export interface LocalAssetProvisionFailure {
  readonly ok: false;
  /** 人话原因（引擎给的）。 */
  readonly message: string;
  /** 可处置提示（引擎 stderr 尾部等）。 */
  readonly hint?: string;
  /** 引擎内部错误码。 */
  readonly engineCode?: string;
  /** 对齐引擎失败形态，便于复用同一段话术。 */
  readonly failure: LocalOcrFailure;
}

export type LocalAssetOutcome = LocalAssetProvisionSuccess | LocalAssetProvisionFailure;

/**
 * 自动备资产（下载模型权重）。
 *
 * ⚠️ **失败就是失败，不重试、不换档、不静默降级**（与解析同一条纪律）：
 * 备不下来 ⇒ 明确报错 + 手动下载命令（D13）。
 */
export async function provisionLocalAssets(
  input: LocalAssetProvisionInput,
): Promise<LocalAssetOutcome> {
  input.logger?.info("Provisioning local OCR model weights", {
    tier: input.tier,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const result = await input.port.downloadModels({
    tier: input.tier,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  if (!result.ok) {
    input.logger?.warn("Local OCR model provisioning failed", {
      tier: input.tier,
      code: result.error?.code ?? "unknown",
      durationMs: result.durationMs,
    });
    const message = result.error?.message ?? "本地模型权重下载失败。";
    const hint = result.error?.hint;
    const engineCode = result.error?.details?.engineCode;
    return {
      ok: false,
      message,
      ...(hint !== undefined ? { hint } : {}),
      ...(typeof engineCode === "string" ? { engineCode } : {}),
      failure: {
        ok: false,
        ruleId: "rule-14",
        message,
        ...(hint !== undefined ? { hint } : {}),
        ...(typeof engineCode === "string" ? { engineCode } : {}),
      },
    };
  }
  input.logger?.info("Local OCR model weights ready", {
    tier: input.tier,
    durationMs: result.durationMs,
  });
  return { ok: true, tier: input.tier, warnings: result.warnings };
}
