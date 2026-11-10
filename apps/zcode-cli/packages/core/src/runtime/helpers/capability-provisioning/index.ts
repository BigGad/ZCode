/**
 * 能力按需供给层（spec：docs/design/v2/capability-provisioning.md）。
 *
 * ⚠️ **本层是独立的一层**，不是给已有层加分支（spec §2 的 D1）：
 * 它回答「这件事此刻能不能做」，不回答「这件事能做什么」（那是 capability 的事）。
 * ⚠️ **判定规则不由模型决定**（D7）：规则表是静态的、可测的。
 */
export {
  PROVISIONING_RULES,
  decideProvisioning,
  isLocalEngineCandidate,
  type ProvisioningRule,
  type ProvisioningRuleContext,
  type ProvisioningRuleStage,
} from "./rules.js";
export {
  projectLocalReadiness,
  resolveLocalInfraReadiness,
  type LocalInfraReadinessCache,
} from "./readiness.js";
export {
  provisionLocalOcr,
  type LocalOcrFailure,
  type LocalOcrOutcome,
  type LocalOcrRequest,
  type LocalOcrSuccess,
} from "./local-ocr.js";
export { buildLocalOcrFailureText, buildLocalOcrText } from "./projection.js";
export type {
  LocalInfraProvisioning,
  LocalReadinessProjection,
  LocalReadinessStatus,
  ProvisioningAttachmentKind,
  ProvisioningDecision,
  ProvisioningRoute,
  ProvisioningRuleId,
} from "./types.js";
