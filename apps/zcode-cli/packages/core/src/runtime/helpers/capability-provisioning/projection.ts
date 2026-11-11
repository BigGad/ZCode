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
  /** 引擎告警（档位被降到 ceiling、取不到页数等）—— local-infra 要求「告知」，不能吞。 */
  readonly warnings?: readonly string[];
}): string {
  const tier = input.tier !== undefined ? ` (tier ${input.tier})` : "";
  const warnings = (input.warnings ?? []).filter((warning) => warning.trim() !== "");
  return [
    `[Attachment parsed by the local OCR engine${tier} because the selected model supports neither image nor PDF input. Source: ${input.filename}]`,
    ...(warnings.length > 0 ? [`[Engine warnings: ${warnings.join("; ")}]`] : []),
    input.markdown,
  ].join("\n");
}

/**
 * 本地 OCR 不可用 / 失败 ⇒ 明确的错误文本。
 *
 * ⚠️ **必须含确定的下一步**（装法 / 下载命令）——「请先安装 MinerU」这种话术不可接受。
 *
 * ⚠️ **三种失败的说法必须分开**（这段文字会被模型转述给用户）：
 *
 * | 性质 | 规则 id | 话术 |
 * | --- | --- | --- |
 * | **路线不可用**（引擎没装 / 模型没下且不能自动备 / `cloud` 未实现 / 拿不到产物目录） | rule-7 / rule-8 / rule-11 / rule-12 | 「模型既不支持图片也不支持 PDF，而本地 OCR 这条路走不通」+ 确定的下一步 |
 * | **引擎调用失败**（路由已判定为本地引擎，执行时引擎跑挂了） | rule-9 | 「本地 OCR 引擎处理这份文档时失败」+ 引擎给的原因 |
 * | **自动备资产失败**（第 2 步：权重没下下来） | rule-14 | 「ZCode 没能自动备好本地 OCR 模型权重」+ 引擎原因 + 手动下载命令 |
 *
 * ⚠️ 引擎明明就绪却说「路线不可用」是自相矛盾；备资产失败更不能说成「路线不可用」。
 */
export function buildLocalOcrFailureText(input: {
  readonly filename: string;
  readonly decision: ProvisioningDecision;
  readonly failure?: LocalOcrFailure;
}): string {
  const kind = resolveFailureKind(input.decision.ruleId, input.failure);
  if (kind === "engine-failed") {
    // 引擎调用失败：不说「路线不可用」，也不重复「引擎已就绪」那条**路由理由**
    // （那是判定为什么走这条路，不是这一次的结果）—— 只说清楚为什么走本地、
    // 这次失败是什么、怎么补救。
    return [
      `[Attachment ${input.filename} could not be parsed: the local OCR engine failed on this document. The local OCR route was chosen because the selected model supports neither image nor PDF input. (rule: ${input.decision.ruleId})]`,
      ...(input.failure !== undefined ? [input.failure.message] : []),
      ...(input.failure?.hint !== undefined ? [input.failure.hint] : []),
    ].join("\n");
  }
  const parts: string[] = [
    kind === "asset-failed"
      ? `[Attachment ${input.filename} could not be parsed: ZCode could not prepare the local OCR model weights automatically. (rule: ${input.decision.ruleId}) ${input.decision.reason}]`
      : `[Attachment ${input.filename} could not be parsed: the selected model supports neither image nor PDF input, and the local OCR route is unavailable. (rule: ${input.decision.ruleId}) ${input.decision.reason}]`,
  ];
  if (kind === "asset-failed" && input.failure !== undefined) {
    parts.push(input.failure.message);
    if (input.failure.hint !== undefined) parts.push(input.failure.hint);
  }
  const nextStep = resolveNextStep(input.decision);
  if (nextStep !== undefined) parts.push(`Next step: ${nextStep}`);
  return parts.join("\n");
}

/** 失败性质 —— 由命中的规则 id 决定（判定与执行阶段的失败都带 id）。 */
function resolveFailureKind(
  ruleId: ProvisioningDecision["ruleId"],
  failure: LocalOcrFailure | undefined,
): "route-unavailable" | "engine-failed" | "asset-failed" {
  if (ruleId === "rule-9") return "engine-failed";
  if (ruleId === "rule-14") return "asset-failed";
  // 兜底：带了失败详情但 id 不是上面两个 ⇒ 按引擎失败说（总比说「路线不可用」准）。
  if (failure !== undefined) return "engine-failed";
  return "route-unavailable";
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
