import { MODEL_CAPABILITIES } from "@zcode/shared/model-selection";
import { resolveCapabilityModelSelection } from "@zcode/provider";
import type { ModelSelection, ModelSelections } from "@zcode/shared/model-selection";

/**
 * 本次运行的能力覆盖（model-selections.md §6.3）。
 *
 * `--capability <能力键>=<类型名>`：把某个能力从「表里同名的键」改指到另一个类型。
 * 典型用途：同一张图，第一次用便宜的图像模型，第二次用效率更好的那个。
 *
 * 覆盖项必须真的支持该能力：指向不支持图像的模型时报错，不静默降级成「不委派」。
 */

/** 已知能力键集合；`--capability` 只接受这些键。 */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(MODEL_CAPABILITIES);

/** 一条覆盖：能力键 → 类型名。 */
export interface CapabilityOverride {
  readonly capability: string;
  readonly typeName: string;
}

/**
 * 解析 `--capability` 的取值。
 *
 * 语法：`<能力键>=<类型名>`。能力键必须是已知能力（当前只有 `image`），
 * 同一个能力重复给出是配置错误 —— 静默取最后一个会让「我配了两个」变成「我配了一个」。
 */
export function parseCapabilityOverrides(
  values: readonly string[],
): { readonly overrides?: readonly CapabilityOverride[]; readonly error?: string } {
  const overrides: CapabilityOverride[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      return {
        error: `Invalid --capability value: ${raw}. Expected <capability>=<model type>.`,
      };
    }
    const capability = value.slice(0, separator).trim();
    const typeName = value.slice(separator + 1).trim();
    if (!KNOWN_CAPABILITIES.has(capability)) {
      return {
        error: `Unknown capability: ${capability}. Available capabilities: ${availableCapabilities().join(", ")}`,
      };
    }
    if (!typeName) {
      return {
        error: `Invalid --capability value: ${raw}. Expected <capability>=<model type>.`,
      };
    }
    if (seen.has(capability)) {
      return { error: `Duplicate --capability for ${capability}.` };
    }
    seen.add(capability);
    overrides.push({ capability, typeName });
  }
  return { overrides };
}

/**
 * 解析覆盖项为可执行的模型选择。
 *
 * 解析不出来（类型不存在、provider/model 不在 Registry 里、或该模型不支持这个能力）
 * 都给一行可操作提示，不静默降级 —— 「配了但没生效」比「明确报错」更难查。
 */
export function resolveCapabilityOverrides(input: {
  readonly overrides: readonly CapabilityOverride[];
  readonly configured?: ModelSelections;
  readonly registry: Parameters<typeof resolveCapabilityModelSelection>[0]["registry"];
}): { readonly selections?: ModelSelections; readonly error?: string } {
  const selections: Record<string, ModelSelection> = {};
  for (const override of input.overrides) {
    const result = resolveCapabilityModelSelection({
      capability: override.capability as (typeof MODEL_CAPABILITIES)[number],
      typeName: override.typeName,
      configured: input.configured,
      registry: input.registry,
    });
    if (!result.selection) {
      return {
        error: `Capability model type "${override.typeName}" is not usable for ${override.capability}: ${result.issue}`,
      };
    }
    selections[override.capability] = result.selection;
  }
  return { selections };
}

/** 已知能力键（供错误提示列出）。 */
export function availableCapabilities(): string[] {
  return [...MODEL_CAPABILITIES];
}
