import { z } from "zod";

/** 用户对后续模型执行的完整选择；不表达已经创建的 Active Model。 */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * 能力键：按输入模态划分的**独立**模型选择（capability-model-selection.md）。
 *
 * 主 LLM 由 `defaultModelSelection` 决定；能力键让某个能力（当前只有图片理解）
 * 走另一个 provider/model。二者互不影响：主模型自己支持该能力时，能力模型不被调用。
 */
export const MODEL_CAPABILITIES = ["image"] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/**
 * 能力 → 模型选择。
 *
 * 键是开放的字符串：新增能力不需要改文件 schema，未知键保留在用户配置里但没有消费方，
 * 不会因为拼错一个键就让整份 Personal Provider Config 读取失败。
 */
export const capabilityModelSelectionsSchema = z.record(z.string().min(1), modelSelectionSchema);

export type CapabilityModelSelections = Readonly<Record<string, ModelSelection>>;

/** 读取某个能力的选择；未知能力键返回 undefined（不是错误）。 */
export function readCapabilityModelSelection(
  selections: CapabilityModelSelections | undefined,
  capability: ModelCapability,
): ModelSelection | undefined {
  return selections?.[capability];
}

/** 公共解析结果。页面可以展示不完整选择，执行入口必须同时检查 selectionIssue。 */
export interface EffectiveModelSelectionResult {
  readonly effectiveSelection: ModelSelection | null;
  readonly selectionIssue?:
    | "selection-missing"
    | "account-connection-unavailable"
    | "provider-not-found"
    | "model-not-found"
    | "reasoning-level-missing"
    | "reasoning-level-not-supported";
}

export const ZCODE_MODEL_REASONING_SEPARATOR = "$";

/** UI Picker/legacy CLI 的展示值；不是可逆的 ModelSelection 序列化格式。 */
export function formatModelPickerValue(selection: ModelSelection | undefined): string {
  // 只在显示边界把未绑定表示为空；实际执行仍校验完整 ModelSelection。
  if (!selection) return "";
  const base = `${selection.providerId}/${selection.modelId}`;
  const reasoningLevel = selection.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

/** 只解析 Picker/legacy 字符串边界；领域状态与协议必须直接保存 ModelSelection。 */
export function parseModelPickerValue(value: string): ModelSelection {
  const normalized = value.trim();
  const providerSeparatorIndex = normalized.indexOf("/");
  if (providerSeparatorIndex <= 0) {
    throw new Error(`模型选择缺少 Provider: ${normalized}`);
  }
  const providerId = normalized.slice(0, providerSeparatorIndex);
  const rawModelId = normalized.slice(providerSeparatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(ZCODE_MODEL_REASONING_SEPARATOR);
  if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
    return modelSelectionSchema.parse({ providerId, modelId: rawModelId });
  }
  return modelSelectionSchema.parse({
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    options: { reasoningLevel: rawModelId.slice(reasoningSeparatorIndex + 1) },
  });
}
