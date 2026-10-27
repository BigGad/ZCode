import {
  MODEL_CAPABILITIES,
  readCapabilityModelSelection,
  type CapabilityModelSelections,
  type ModelCapability,
  type ModelSelection,
} from "@zcode/shared/model-selection";
import type { ProviderRegistryView } from "./registry.js";

/**
 * 能力模型解析（capability-model-selection.md §4）。
 *
 * 能力模型与主模型是两条独立的选择：主模型由 `defaultModelSelection` 决定，
 * 能力模型按能力键（当前只有 `image`）单独指定。解析只做只读校验，不写配置。
 */

/** 解析失败的原因码；调用方按「没有能力模型」降级，不抛异常。 */
export type CapabilityModelSelectionIssue =
  | "capability-not-configured"
  | "provider-not-found"
  | "model-not-found"
  | "capability-not-supported";

export type CapabilityModelSelectionResult =
  | { readonly selection: ModelSelection; readonly issue?: undefined }
  | { readonly selection?: undefined; readonly issue: CapabilityModelSelectionIssue };

export function resolveCapabilityModelSelection(input: {
  readonly capability: ModelCapability;
  readonly configured?: CapabilityModelSelections;
  readonly registry: ProviderRegistryView;
}): CapabilityModelSelectionResult {
  const selection = readCapabilityModelSelection(input.configured, input.capability);
  if (!selection) return { issue: "capability-not-configured" };

  const provider = input.registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (!provider) return { issue: "provider-not-found" };

  const model = provider.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return { issue: "model-not-found" };

  if (!modelSupportsCapability(model, input.capability)) {
    return { issue: "capability-not-supported" };
  }
  return { selection: completeCapabilityModelSelection(model, selection) };
}

/**
 * 补齐可执行的推理档位。
 *
 * Model Factory 只接受完整执行选择（缺档位会抛 "Reasoning level is required"），
 * 所以补齐必须发生在**创建 Model 之前**，不能等 Model 建好再 bind。
 * 配置里显式声明的档位只要模型支持就保留；缺失或不支持时退回模型的最低公开档位
 * —— 能力模型承担的是「读一张图」这类旁路调用，最低公开档位够用且更便宜。
 */
function completeCapabilityModelSelection(
  model: ProviderRegistryView["providers"][number]["models"][number],
  selection: ModelSelection,
): ModelSelection {
  const values = model.config.optionSpecs?.reasoningLevel?.values ?? [];
  if (values.length === 0) return selection;
  const requested = selection.options?.reasoningLevel;
  const reasoningLevel = requested && values.includes(requested) ? requested : values[0]!;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { ...selection.options, reasoningLevel },
  };
}

/** 已知能力键集合：配置里的未知键保留但不消费，不参与解析。 */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(MODEL_CAPABILITIES);

export interface ResolvedCapabilityModelSelections {
  /** 解析成功的能力选择；未配置或解析失败的键不出现。 */
  readonly selections: CapabilityModelSelections;
  /** 解析失败的原因码；调用方按「没有能力模型」降级，不抛异常。 */
  readonly issues: ReadonlyArray<{
    readonly capability: string;
    readonly issue: CapabilityModelSelectionIssue;
  }>;
}

/**
 * 解析整份能力模型配置。
 *
 * 每个能力独立解析：某一个能力配置失效不影响其它能力。未知能力键保留在配置里
 * 但不消费，也不报错 —— 配置文件的向前兼容由 schema 负责。
 */
export function resolveConfiguredCapabilityModelSelections(input: {
  readonly configured?: CapabilityModelSelections;
  readonly registry: ProviderRegistryView;
}): ResolvedCapabilityModelSelections {
  const issues: Array<{ capability: string; issue: CapabilityModelSelectionIssue }> = [];
  const selections: Record<string, ModelSelection> = {};
  for (const capability of Object.keys(input.configured ?? {})) {
    if (!KNOWN_CAPABILITIES.has(capability)) continue;
    const result = resolveCapabilityModelSelection({
      capability: capability as ModelCapability,
      configured: input.configured,
      registry: input.registry,
    });
    if (result.selection) selections[capability] = result.selection;
    else issues.push({ capability, issue: result.issue });
  }
  return { selections: Object.freeze(selections), issues: Object.freeze(issues) };
}

/**
 * 能力位取**解析后**的 `properties.inputFormat`：规则文件是 match/overlay 的输入，
 * 只有解析结果才是某个具体模型的真实能力（与 `recognize-model.ts` 同源）。
 */
function modelSupportsCapability(
  model: ProviderRegistryView["providers"][number]["models"][number],
  capability: ModelCapability,
): boolean {
  const inputFormat = model.config.properties?.inputFormat;
  if (!inputFormat) return false;
  switch (capability) {
    case "image":
      return inputFormat.supportsImage === true;
  }
}
