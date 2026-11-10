import type { MineruTier } from "../../deps.js";
import type { LocalOcrFailure } from "./local-ocr.js";
import type { ProvisioningDecision } from "./types.js";

/**
 * 判定结果 → 模型可见的文本（spec：docs/design/v2/capability-provisioning.md §7.3 / §8.4）。
 *
 * ⚠️ **这不是调试信息，是用户可见的一行**：模型要能据此向用户说清
 * 「为什么这个文件走了本地 OCR」「为什么走不了」。
 * ⚠️ 语言沿用既有的媒体降级文案（英文），**确切的下一步命令逐字保留**。
 */

/** 本地 OCR 成功 ⇒ 投影进 prompt 的正文。 */
export function buildLocalOcrText(input: {
  readonly filename: string;
  readonly markdown: string;
  readonly tier?: MineruTier;
}): string {
  const tier = input.tier !== undefined ? ` (tier ${input.tier})` : "";
  return [
    `[Attachment parsed by the local OCR engine${tier} because the selected model supports neither image nor PDF input. Source: ${input.filename}]`,
    input.markdown,
  ].join("\n");
}

/**
 * 本地 OCR 不可用 / 失败 ⇒ 明确的错误文本。
 *
 * ⚠️ **必须含确定的下一步**（装法 / 下载命令）——「请先安装 MinerU」这种话术不可接受。
 */
export function buildLocalOcrFailureText(input: {
  readonly filename: string;
  readonly decision: ProvisioningDecision;
  readonly failure?: LocalOcrFailure;
}): string {
  const parts: string[] = [
    `[Attachment ${input.filename} could not be parsed: the selected model supports neither image nor PDF input, and the local OCR route is unavailable. ${input.decision.reason}`,
  ];
  const nextStep = resolveNextStep(input.decision);
  if (nextStep !== undefined) parts.push(`Next step: ${nextStep}`);
  if (input.failure !== undefined) {
    parts.push(input.failure.message);
    if (input.failure.hint !== undefined) parts.push(input.failure.hint);
  }
  return parts.join("\n");
}

/** 确定的下一步：装法 / 下载命令 / 体检命令（三者互斥，按就绪状态的性质选）。 */
function resolveNextStep(decision: ProvisioningDecision): string | undefined {
  const readiness = decision.readiness;
  if (readiness === undefined) return undefined;
  if (readiness.installCommand !== undefined) return readiness.installCommand;
  if (readiness.downloadCommand !== undefined) return readiness.downloadCommand;
  if (readiness.status === "not-ready" || readiness.status === "unknown") {
    // 下载命令给不出来（档位没有仓库映射 / 问不出状态）⇒ 让用户先体检。
    return "zcode ocr doctor";
  }
  return undefined;
}
