import type { DegradationPolicy, ModelInputFormat } from "../../deps.js";
import type {
  LocalReadinessProjection,
  ProvisioningAttachmentKind,
  ProvisioningDecision,
  ProvisioningRoute,
  ProvisioningRuleId,
} from "./types.js";

/**
 * 判定规则表（spec：docs/design/v2/capability-provisioning.md §7.2）。
 *
 * ⚠️ **规则表是数据，不是代码分支**：每一行带 id、可单独测试，判定结果能回答
 * 「为什么走这条路」「为什么不走另一条路」（spec §7.3）。
 *
 * ⚠️ **触发条件全部收紧**：模型能力位是 `undefined` 时一律维持现状（`rule-10`），
 * 不委派 —— **未知不等于拒绝**（与 `capability-image-description.ts` 的纪律一致）。
 */

/** 判定阶段：`capability` 只看能力位（无 I/O）；`readiness` 还要看就绪状态；`fallback` 是兜底。 */
export type ProvisioningRuleStage = "capability" | "readiness" | "fallback";

/** 判定上下文。`readiness` 是**懒取**的：只有真正需要的规则才会触发环境探测。 */
export interface ProvisioningRuleContext {
  readonly attachmentKind: ProvisioningAttachmentKind;
  readonly modelInputFormat?: ModelInputFormat;
  readonly degradation: DegradationPolicy;
  /** 未就位时是否**自动备资产**（第 2 步，配置键 `ocr.autoProvision`，默认 `true`）。 */
  readonly autoProvision: boolean;
  /** 就绪状态（任务内缓存，跨进程不缓存）。 */
  readonly readiness: () => Promise<LocalReadinessProjection | undefined>;
}

/** 规则表的一行。 */
export interface ProvisioningRule {
  readonly id: ProvisioningRuleId;
  readonly attachmentKind: ProvisioningAttachmentKind;
  readonly stage: ProvisioningRuleStage;
  readonly route: ProvisioningRoute;
  /** 命中条件。 */
  readonly matches: (context: ProvisioningRuleContext) => boolean | Promise<boolean>;
  /** 人话理由（一行）。 */
  readonly reason: string | ((readiness: LocalReadinessProjection | undefined) => string);
  /**
   * 命中后**执行前要先备资产**（第 2 步）。
   *
   * ⚠️ 判定与执行分开：判定只说「走本地引擎」，备资产（下载权重）是执行阶段的事。
   */
  readonly requiresProvisioning?: boolean;
}

/** 阶段顺序：能力位 → 就绪状态 → 兜底。 */
const RULE_STAGES: readonly ProvisioningRuleStage[] = ["capability", "readiness", "fallback"];

/**
 * 规则表本体。
 *
 * ⚠️ **行序即优先级**：能力阶段的行先判；命中不了且属于「本地引擎候选」时进就绪阶段；
 * 都不命中才落到兜底行。
 */
export const PROVISIONING_RULES: readonly ProvisioningRule[] = [
  {
    id: "rule-1",
    attachmentKind: "text",
    stage: "capability",
    route: "existing",
    matches: (context) => context.attachmentKind === "text",
    reason: "文本附件走现有文本路线。",
  },
  {
    id: "rule-2",
    attachmentKind: "image",
    stage: "capability",
    route: "existing",
    matches: (context) =>
      context.attachmentKind === "image" && context.modelInputFormat?.supportsImage !== false,
    reason: "模型支持图片输入，走现有图片路线。",
  },
  {
    id: "rule-3",
    attachmentKind: "image",
    stage: "capability",
    route: "existing",
    matches: (context) =>
      context.attachmentKind === "image" && context.modelInputFormat?.supportsImage === false,
    reason: "模型显式不支持图片，走现有能力模型描述路线。",
  },
  {
    id: "rule-4",
    attachmentKind: "pdf",
    stage: "capability",
    route: "existing",
    matches: (context) =>
      context.attachmentKind === "pdf" && context.modelInputFormat?.supportsImage === true,
    reason: "模型有视觉能力（supportsImage=true），走现有页图渲染路线。",
  },
  {
    id: "rule-5",
    attachmentKind: "pdf",
    stage: "capability",
    route: "existing",
    matches: (context) =>
      context.attachmentKind === "pdf" &&
      context.modelInputFormat?.supportsImage !== true &&
      context.modelInputFormat?.supportsPdf === true,
    reason: "模型原生支持 PDF（supportsPdf=true），走现有 file block 路线。",
  },
  {
    id: "rule-11",
    attachmentKind: "pdf",
    stage: "readiness",
    route: "error",
    matches: (context) => isLocalEngineCandidate(context) && context.degradation === "cloud",
    reason: "降级策略 `cloud` 当前版本尚未实现（capability-provisioning.md §6），已明确拒绝。",
  },
  {
    id: "rule-6",
    attachmentKind: "pdf",
    stage: "readiness",
    route: "local-engine",
    matches: async (context) =>
      isLocalEngineCandidate(context) && (await context.readiness())?.status === "ready",
    reason: "模型既不支持 PDF 也不支持图片，本地解析引擎已就绪，走本地 OCR。",
  },
  {
    id: "rule-7",
    attachmentKind: "pdf",
    stage: "readiness",
    route: "error",
    matches: async (context) =>
      isLocalEngineCandidate(context) && (await context.readiness())?.status === "unavailable",
    reason: "模型既不支持 PDF 也不支持图片，但本地解析引擎不可用。",
  },
  {
    id: "rule-13",
    attachmentKind: "pdf",
    stage: "readiness",
    route: "local-engine",
    // ⚠️ **判在 rule-8 之前**：两者都是「第 ③ 层不就位」，
    // 区别只在**能不能自己搞定**（自动备开关开着 + 该档位有仓库映射）。
    matches: async (context) => {
      if (!isLocalEngineCandidate(context)) return false;
      if (!context.autoProvision) return false;
      const readiness = await context.readiness();
      if (readiness?.status !== "not-ready") return false;
      // 没有可执行的下载命令 ⇒ 备不了（档位没有仓库映射）⇒ 交给 rule-8 报错。
      return readiness.downloadCommand !== undefined;
    },
    reason: "模型既不支持 PDF 也不支持图片，本地模型尚未就绪，先自动备资产再解析。",
    requiresProvisioning: true,
  },
  {
    id: "rule-8",
    attachmentKind: "pdf",
    stage: "readiness",
    route: "error",
    matches: async (context) => {
      if (!isLocalEngineCandidate(context)) return false;
      const status = (await context.readiness())?.status;
      return status === "not-ready" || status === "unknown";
    },
    reason: (readiness) =>
      readiness?.status === "unknown"
        ? "模型既不支持 PDF 也不支持图片，且无法确认本地模型是否就绪。"
        : "模型既不支持 PDF 也不支持图片，但本地模型尚未就绪。",
  },
  {
    id: "rule-10",
    attachmentKind: "pdf",
    stage: "fallback",
    route: "existing",
    matches: (context) => context.attachmentKind === "pdf",
    reason: "模型能力位未知，维持现状，不委派本地 OCR。",
  },
];

/**
 * 本地引擎候选条件（spec §7.2 第 6 行的触发条件）。
 *
 * ⚠️ **两个 `=== false` 都要**：页图路线本质是 image block（`supportsImage` 决定），
 * file block 路线要 `supportsPdf` 支持 —— 两个都不行时，本地 OCR 是唯一能在
 * **不把文档送出机器**的前提下拿到文字的路。
 */
export function isLocalEngineCandidate(context: {
  readonly modelInputFormat?: ModelInputFormat;
}): boolean {
  const format = context.modelInputFormat;
  return format?.supportsImage === false && format?.supportsPdf === false;
}

/**
 * 判定入口。
 *
 * ⚠️ **两阶段**：能力位判定是同步的（无 I/O）；只有命中本地引擎候选时才取就绪状态
 * （一次探测，任务内缓存）。
 */
export async function decideProvisioning(input: {
  readonly attachmentKind: ProvisioningAttachmentKind;
  readonly modelInputFormat?: ModelInputFormat;
  readonly degradation: DegradationPolicy;
  /** 未就位时是否自动备资产（第 2 步；配置键 `ocr.autoProvision`）。 */
  readonly autoProvision: boolean;
  readonly resolveReadiness?: () => Promise<LocalReadinessProjection | undefined>;
}): Promise<ProvisioningDecision> {
  let readinessPromise: Promise<LocalReadinessProjection | undefined> | undefined;
  const localCandidate = isLocalEngineCandidate({ modelInputFormat: input.modelInputFormat });
  if (localCandidate && input.resolveReadiness === undefined) {
    // 供给层没装配（端口缺席）⇒ **行为不变**：不委派、不报错。
    return {
      ruleId: "rule-10",
      route: "existing",
      degradation: input.degradation,
      reason: "本地能力供给端口未装配，维持现状（不委派本地 OCR）。",
    };
  }
  const context: ProvisioningRuleContext = {
    attachmentKind: input.attachmentKind,
    ...(input.modelInputFormat !== undefined ? { modelInputFormat: input.modelInputFormat } : {}),
    degradation: input.degradation,
    autoProvision: input.autoProvision,
    // 懒取 + 记忆化：探测成本只付一次，且只有真正需要的规则才会触发。
    readiness: () => {
      readinessPromise ??= input.resolveReadiness?.() ?? Promise.resolve(undefined);
      return readinessPromise;
    },
  };

  for (const stage of RULE_STAGES) {
    for (const rule of PROVISIONING_RULES) {
      if (rule.stage !== stage) continue;
      if (rule.attachmentKind !== input.attachmentKind) continue;
      if (!(await rule.matches(context))) continue;
      const readiness = stage === "readiness" ? await context.readiness() : undefined;
      return {
        ruleId: rule.id,
        route: rule.route,
        degradation: input.degradation,
        ...(readiness !== undefined ? { readiness } : {}),
        ...(rule.requiresProvisioning === true ? { requiresProvisioning: true } : {}),
        reason: resolveReason(rule.reason, readiness),
      };
    }
  }

  // 兜底：本地引擎候选却定不出路线（就绪状态问不出来）⇒ **明确报错**，不静默回落。
  if (localCandidate) {
    return {
      ruleId: "rule-8",
      route: "error",
      degradation: input.degradation,
      reason: "本地解析引擎的就绪状态未知，无法自动使用本地 OCR。",
    };
  }
  return {
    ruleId: "rule-10",
    route: "existing",
    degradation: input.degradation,
    reason: "未命中任何能力供给规则，维持现状。",
  };
}

function resolveReason(
  reason: ProvisioningRule["reason"],
  readiness: LocalReadinessProjection | undefined,
): string {
  return typeof reason === "function" ? reason(readiness) : reason;
}
