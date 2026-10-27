import { resolveModelTypeSelection } from "@zcode/provider";
import type { ModelSelection, ModelSelections } from "@zcode/shared/model-selection";

/**
 * 命名模型类型的解析与选择（model-selections.md §6）。
 *
 * 「模型类型」= Personal Provider Config 的 `modelSelections` 表里的一个键。
 * 调用方（`--model-type` / `/model-type`）按名字点名，解析出可执行的模型选择。
 */

/** 一个命名模型类型：名字 + 它解析出的完整选择。 */
export interface ModelTypeOption {
  readonly name: string;
  readonly selection: ModelSelection;
}

/** 表里有哪些类型名（字典序）；没有配置时是空数组。 */
export function listModelTypeNames(configured: ModelSelections | undefined): string[] {
  return Object.keys(configured ?? {}).sort();
}

/**
 * 解析一个类型名。
 *
 * 返回 undefined 表示「这个名字不可用」：类型不存在、provider/model 不在 Registry 里。
 * 不可用不是异常 —— 调用方按「没有这个类型」给可操作提示。
 */
export function resolveModelTypeOption(input: {
  readonly name: string;
  readonly configured?: ModelSelections;
  readonly registry: Parameters<typeof resolveModelTypeSelection>[0]["registry"];
}): ModelTypeOption | undefined {
  const result = resolveModelTypeSelection({
    name: input.name,
    configured: input.configured,
    registry: input.registry,
  });
  return result.selection ? { name: input.name, selection: result.selection } : undefined;
}

/** 列出全部**可用**的类型（解析成功的）；不可用的类型不进列表。 */
export function listModelTypeOptions(input: {
  readonly configured?: ModelSelections;
  readonly registry: Parameters<typeof resolveModelTypeSelection>[0]["registry"];
}): ModelTypeOption[] {
  const options: ModelTypeOption[] = [];
  for (const name of listModelTypeNames(input.configured)) {
    const option = resolveModelTypeOption({ name, configured: input.configured, registry: input.registry });
    if (option) options.push(option);
  }
  return options;
}

/**
 * 类型名不可用时的提示。
 *
 * 列出**配置里实际存在**的类型名（不解析可用性）：用户看到的是「我配了哪些」，
 * 而不是「哪些碰巧能用」——后者会把「provider 没登录」这类问题藏起来。
 */
export function formatUnknownModelTypeMessage(
  name: string,
  available: readonly string[],
): string {
  const list = available.length > 0 ? available.join(", ") : "(none)";
  return `Unknown model type: ${name}. Available types: ${list}`;
}

/**
 * 解析「调用方点名的那个类型」。
 *
 * 没点名 → 没有选择（调用方沿用 `defaultModelSelection`）。
 * 点名了但解析不出来 → `error` 是可直接写给用户的一行提示。
 */
export function resolveRequestedModelType(input: {
  readonly name?: string;
  readonly configured?: ModelSelections;
  readonly registry: Parameters<typeof resolveModelTypeSelection>[0]["registry"];
}): { readonly selection?: ModelSelection; readonly error?: string } {
  const name = input.name?.trim();
  if (!name) return {};
  const option = resolveModelTypeOption({
    name,
    configured: input.configured,
    registry: input.registry,
  });
  if (option) return { selection: option.selection };
  return {
    error: formatUnknownModelTypeMessage(name, listModelTypeNames(input.configured)),
  };
}
