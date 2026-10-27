import {
  MODEL_CAPABILITIES,
  readModelSelection,
  type ModelCapability,
  type ModelSelection,
  type ModelSelections,
} from "@zcode/shared/model-selection";
import type { ProviderRegistryView } from "./registry.js";

/**
 * 命名模型类型解析（model-selections.md §4）。
 *
 * 一张 `modelSelections` 表服务两类消费方：人按类型名点名（`--model-type fast`），
 * 以及运行时按能力键自动取用（`modelSelections.image`）。解析只做只读校验，不写配置。
 */

/** 解析失败的原因码；调用方按「没有该类型」降级，不抛异常。 */
export type ModelTypeSelectionIssue =
  | "model-type-not-configured"
  | "provider-not-found"
  | "model-not-found"
  | "capability-not-supported";

export type ModelTypeSelectionResult =
  | { readonly selection: ModelSelection; readonly issue?: undefined }
  | { readonly selection?: undefined; readonly issue: ModelTypeSelectionIssue };

/**
 * 解析一个类型名。
 *
 * 不做能力校验：人点名的类型就是他要的，即使那个模型不支持当前能力也不拦。
 * 能力校验只发生在能力键的自动取用路径（`resolveCapabilityModelSelections`）。
 */
export function resolveModelTypeSelection(input: {
  readonly name: string;
  readonly configured?: ModelSelections;
  readonly registry: ProviderRegistryView;
}): ModelTypeSelectionResult {
  const selection = readModelSelection(input.configured, input.name);
  if (!selection) return { issue: "model-type-not-configured" };

  const provider = input.registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (!provider) return { issue: "provider-not-found" };

  const model = provider.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return { issue: "model-not-found" };

  return { selection: completeModelTypeSelection(model, selection) };
}

/** 已知能力键集合：配置里的未知类型名保留在用户文件里但不被消费，也不报错。 */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(MODEL_CAPABILITIES);

export interface ResolvedCapabilityModelSelections {
  /** 解析成功的能力选择；未配置或解析失败的键不出现。 */
  readonly selections: ModelSelections;
  /** 解析失败的原因码；调用方按「没有能力模型」降级，不抛异常。 */
  readonly issues: ReadonlyArray<{
    readonly capability: string;
    readonly issue: ModelTypeSelectionIssue;
  }>;
}

/**
 * 解析「某个能力由哪个类型承担」。
 *
 * 与 `resolveModelTypeSelection` 的区别：这里**额外校验能力位**。
 * 能力键的默认绑定是表里同名的键；调用方（`--capability image=image-cheap`）
 * 可以在本次运行里改指另一个类型，但被指的类型必须真的支持该能力 ——
 * 指向不支持图像的模型时报错，不静默降级成「不委派」。
 */
export function resolveCapabilityModelSelection(input: {
  readonly capability: ModelCapability;
  readonly typeName: string;
  readonly configured?: ModelSelections;
  readonly registry: ProviderRegistryView;
}): ModelTypeSelectionResult {
  const result = resolveModelTypeSelection({
    name: input.typeName,
    configured: input.configured,
    registry: input.registry,
  });
  if (!result.selection) return result;

  const model = findModel(input.registry, result.selection);
  if (!model) return { issue: "model-not-found" };
  if (!modelSupportsCapability(model, input.capability)) {
    return { issue: "capability-not-supported" };
  }
  return result;
}

/**
 * 解析全部**能力键**的模型选择。
 *
 * 每个能力独立解析：某一个能力配置失效不影响其它能力。未知类型名保留在配置里
 * 但不消费，也不报错 —— 配置文件的向前兼容由 schema 负责。
 */
export function resolveCapabilityModelSelections(input: {
  readonly configured?: ModelSelections;
  readonly registry: ProviderRegistryView;
}): ResolvedCapabilityModelSelections {
  const issues: Array<{ capability: string; issue: ModelTypeSelectionIssue }> = [];
  const selections: Record<string, ModelSelection> = {};
  for (const capability of Object.keys(input.configured ?? {})) {
    if (!KNOWN_CAPABILITIES.has(capability)) continue;
    const result = resolveModelTypeSelection({
      name: capability,
      configured: input.configured,
      registry: input.registry,
    });
    if (!result.selection) {
      issues.push({ capability, issue: result.issue });
      continue;
    }
    const model = findModel(input.registry, result.selection);
    if (!model) {
      issues.push({ capability, issue: "model-not-found" });
      continue;
    }
    if (!modelSupportsCapability(model, capability as ModelCapability)) {
      issues.push({ capability, issue: "capability-not-supported" });
      continue;
    }
    selections[capability] = result.selection;
  }
  return { selections: Object.freeze(selections), issues: Object.freeze(issues) };
}

/**
 * 补齐可执行的推理档位。
 *
 * Model Factory 只接受完整执行选择（缺档位会抛 "Reasoning level is required"），
 * 所以补齐必须发生在**创建 Model 之前**，不能等 Model 创建后再 bind。
 * 配置里显式声明的档位只要模型支持就保留；缺失或不支持时退回模型的最低公开档位
 * —— 能力模型承担的是「读一张图」这类旁路调用，最低公开档位够用且更便宜。
 */
function completeModelTypeSelection(
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

/** 按 Registry 快照定位模型；provider 不存在与 model 不存在要分开报。 */
function findModel(
  registry: ProviderRegistryView,
  selection: ModelSelection,
): ProviderRegistryView["providers"][number]["models"][number] | undefined {
  const provider = registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (!provider) return undefined;
  return provider.models.find((candidate) => candidate.modelId === selection.modelId);
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
