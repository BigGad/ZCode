import type { DegradationPolicy, LocalInfraPort, MineruTier } from "../../deps.js";

/**
 * 能力供给层的类型（spec：docs/design/v2/capability-provisioning.md）。
 *
 * ⚠️ **本层叫 readiness / provisioning，不叫 capability**（spec §8.1）：
 * 「能力」是「这件事能做什么」，本层是「这件事此刻能不能做」——
 * 两个词混用会让 `capability` 一词二义。
 */

/** 判定输出的路线。 */
export type ProvisioningRoute =
  /** 走本地引擎（本层新增的路线）。 */
  | "local-engine"
  /** 走既有路线（行为不变）。 */
  | "existing"
  /** 明确报错（不就位 / 策略未实现）。 */
  | "error";

/**
 * 规则 id（spec §7.2 的行号）。
 *
 * ⚠️ `rule-11` 不在 §7.2 的原始表里：它是「降级策略 `cloud` 在 v1 未实现」的显式拒绝，
 * 补进来是为了让**每一行判定都有 id**（可解释性依赖 id，见 §7.3）。
 */
export type ProvisioningRuleId =
  | "rule-1"
  | "rule-2"
  | "rule-3"
  | "rule-4"
  | "rule-5"
  | "rule-6"
  | "rule-7"
  | "rule-8"
  | "rule-9"
  | "rule-10"
  | "rule-11";

/** 规则表的输入维度：附件种类。 */
export type ProvisioningAttachmentKind = "text" | "image" | "pdf";

/**
 * 就绪状态（spec §4 的三层）。
 *
 * - `ready` —— 三层全绿；
 * - `unavailable` —— 第 ①② 层不就位（**不可用**：ZCode 没资格代装第三方可执行文件）；
 * - `not-ready` —— 第 ③ 层不就位（**未就位**：模型仓库没下载）；
 * - `unknown` —— 引擎在，但问不出模型状态（`models show` 失败）。
 */
export type LocalReadinessStatus = "ready" | "unavailable" | "not-ready" | "unknown";

/** 就绪状态的投影（从 `doctor()` 报告投影而来，spec §8.3）。 */
export interface LocalReadinessProjection {
  readonly status: LocalReadinessStatus;
  /** 解析时用的档位；不就绪时是「应当准备的那个档位」。 */
  readonly tier?: MineruTier;
  /** 装法（第 ①② 层不就位时给）。 */
  readonly installCommand?: string;
  /** 下载命令（第 ③ 层不就位时给，`zcode ocr models download --tier <t>`）。 */
  readonly downloadCommand?: string;
  /** 人话理由（一行）。 */
  readonly reason: string;
}

/** 判定结果 —— 规则表命中的那一行 + 为什么（spec §8.4）。 */
export interface ProvisioningDecision {
  /** 命中的规则 id（逐行可测、用户可答疑）。 */
  readonly ruleId: ProvisioningRuleId;
  /** 路线。 */
  readonly route: ProvisioningRoute;
  /** 降级策略（D3）。v1 只有 `error`。 */
  readonly degradation: DegradationPolicy;
  /** 就绪状态（仅本地路线有意义）。 */
  readonly readiness?: LocalReadinessProjection;
  /** 人话理由（一行）。 */
  readonly reason: string;
}

/**
 * 能力供给层的输入（spec §8.3）。
 *
 * ⚠️ **整包缺席即「本轮不做能力供给」**：附件链保持既有行为，不委派本地 OCR。
 */
export interface LocalInfraProvisioning {
  readonly port: LocalInfraPort;
  readonly degradation: DegradationPolicy;
  /** 就绪状态（任务内缓存 —— 探测会 spawn 子进程，同一轮里只付一次）。 */
  readonly resolveReadiness: () => Promise<LocalReadinessProjection | undefined>;
}
