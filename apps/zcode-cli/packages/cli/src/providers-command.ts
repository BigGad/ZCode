import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { RunDependencies } from "./cli-types.js";

/**
 * `zcode providers init`：生成/补齐 Personal Provider Config 的具名模型选择。
 *
 * 生成的类型名来自**用户真实配置的 provider**，每个类型指向 registry 里真实可选的模型，
 * 所以生成完立刻能用：`zcode -p "…" --model-type main`。
 *
 * 写回是**合并**语义：已有的同名类型不动（用户可能已经手调过档位或指向别的模型），
 * 已有的 provider 规则与凭据也一律不动。只有缺失的具名类型会被补上。
 */

/** 主模型类型的名字；与 `defaultModelSelection` 同义，方便「主/快/视觉」三档。 */
const MAIN_TYPE_NAME = "main";
/** 图片理解能力键的类型名；与能力键同名（能力键就是表里的键）。 */
const IMAGE_TYPE_NAME = "image";

export interface ProvidersCommandFlags {
  readonly dryRun?: boolean;
}

/** 模型配置里与档位有关的那部分。 */
interface ModelOptionSpecsHolder {
  readonly optionSpecs?: { readonly reasoningLevel?: { readonly values?: readonly string[] } };
}

export async function runProvidersCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  positionals: readonly string[],
  flags: ProvidersCommandFlags = {},
): Promise<number> {
  const subcommand = positionals[0] ?? "init";
  if (subcommand !== "init") {
    ctx.stderr.write(`Unknown providers subcommand: ${subcommand}\n\n`);
    ctx.stderr.write("Usage: zcode providers init [--dry-run]\n");
    return 1;
  }

  const bootstrap = await loadBootstrapModule();
  const startProviderRegistryRuntime =
    deps.startProcessProviderRegistryRuntime ?? bootstrap.startProcessProviderRegistryRuntime;
  const runtime = await startProviderRegistryRuntime(process.env);
  try {
    const snapshot = runtime.runtime.registryService.getSnapshot();
    const view = snapshot?.registry ?? { revision: 0, providers: [] };
    const configuredDefault = runtime.configuredDefaultModelSelection;
    const existing = runtime.modelSelectionConfigRepository
      ? await runtime.modelSelectionConfigRepository.readModelSelections()
      : undefined;

    const generated = generateModelTypeSelections({
      configuredDefault,
      providers: view.providers,
    });

    if (generated.length === 0) {
      ctx.stderr.write(
        "No selectable model found in the provider registry. Configure a provider first (see docs/model-types-setup.md).\n",
      );
      return 1;
    }

    const added = generated.filter((entry) => existing?.[entry.name] === undefined);
    const skipped = generated.filter((entry) => existing?.[entry.name] !== undefined);

    if (flags.dryRun) {
      ctx.stdout.write("Would add to modelSelections:\n");
      for (const entry of added) {
        ctx.stdout.write(`  ${entry.name} -> ${formatSelection(entry.selection)}\n`);
      }
      for (const entry of skipped) {
        ctx.stdout.write(`  ${entry.name} -> (kept, already configured)\n`);
      }
      return 0;
    }

    const personalRepository = runtime.runtime.personalRepository;
    if (!personalRepository) {
      ctx.stderr.write("Personal Provider Config storage is unavailable.\n");
      return 1;
    }
    // 合并写：已有同名类型不动，用户改过的 provider 与凭据也不动。
    await personalRepository.update((current) => ({
      ...current,
      modelSelections: {
        ...current.modelSelections,
        ...Object.fromEntries(added.map((entry) => [entry.name, entry.selection])),
      },
    }));

    ctx.stdout.write(`Model types written to Personal Provider Config:\n`);
    for (const entry of added) {
      ctx.stdout.write(`  ${entry.name} -> ${formatSelection(entry.selection)}\n`);
    }
    for (const entry of skipped) {
      ctx.stdout.write(`  ${entry.name} -> (kept, already configured)\n`);
    }
    ctx.stdout.write(
      "\nUse them with --model-type <name>; list them with /model-type list inside the TUI.\n",
    );
    return 0;
  } finally {
    runtime.dispose();
  }
}

/**
 * 从 registry 生成具名类型。
 *
 * - `main`：当前默认选择；没有默认就用第一个可选模型。
 * - `image`：当前默认选择**支持图像时**就是它；否则取第一个支持图像输入的模型（能力委派要它）。
 * - `<providerId>`：该 provider 的第一个可选模型，让「多套模型地址」各自有个能点名的类型。
 */
export function generateModelTypeSelections(input: {
  readonly configuredDefault?: ModelSelection;
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly properties?: { readonly inputFormat?: { readonly supportsImage?: boolean } };
        readonly optionSpecs?: { readonly reasoningLevel?: { readonly values?: readonly string[] } };
      };
    }[];
  }[];
}): Array<{ readonly name: string; readonly selection: ModelSelection }> {
  const entries: Array<{ name: string; selection: ModelSelection }> = [];
  const seen = new Set<string>();

  const push = (name: string, selection: ModelSelection) => {
    if (seen.has(name)) return;
    seen.add(name);
    entries.push({ name, selection });
  };

  const selectable = input.providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );

  const defaultEntry = input.configuredDefault
    ? selectable.find(
        (entry) =>
          entry.provider.providerId === input.configuredDefault?.providerId &&
          entry.model.modelId === input.configuredDefault?.modelId,
      )
    : undefined;
  if (defaultEntry) {
    push(MAIN_TYPE_NAME, completeFromConfigured(input.configuredDefault!, defaultEntry.model));
  } else {
    const first = selectable[0];
    if (first) {
      push(MAIN_TYPE_NAME, completeFromCatalog(first.model, first.provider));
    }
  }

  const imageEntry = defaultEntry?.model.config.properties?.inputFormat?.supportsImage
    ? defaultEntry
    : selectable.find(
        (entry) => entry.model.config.properties?.inputFormat?.supportsImage === true,
      );
  if (imageEntry) {
    push(
      IMAGE_TYPE_NAME,
      defaultEntry === imageEntry
        ? completeFromConfigured(input.configuredDefault!, imageEntry.model)
        : completeFromCatalog(imageEntry.model, imageEntry.provider),
    );
  }

  for (const provider of input.providers) {
    const model = provider.models[0];
    if (!model) continue;
    push(provider.providerId, completeFromCatalog(model, provider));
  }

  return entries;
}

/** 沿用已有选择里的档位：配置里声明的档位只要模型支持就保留。 */
function completeFromConfigured(
  selection: ModelSelection,
  model: { readonly modelId: string; readonly config: ModelOptionSpecsHolder },
): ModelSelection {
  const values = model.config.optionSpecs?.reasoningLevel?.values ?? [];
  const requested = selection.options?.reasoningLevel;
  const reasoningLevel = requested && values.includes(requested) ? requested : values[0];
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel ? { options: { ...selection.options, reasoningLevel } } : {}),
  };
}

/**
 * 目录默认档位（与 picker 选模型时的口径一致）。
 *
 * Model Factory 只接受完整执行选择，缺档位会直接报错 —— 所以生成时必须补齐。
 */
function completeFromCatalog(
  model: { readonly modelId: string; readonly config: ModelOptionSpecsHolder },
  provider: { readonly providerId: string },
): ModelSelection {
  const values = model.config.optionSpecs?.reasoningLevel?.values ?? [];
  const reasoningLevel = values.at(-1);
  return {
    providerId: provider.providerId,
    modelId: model.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

function formatSelection(selection: ModelSelection): string {
  const level = selection.options?.reasoningLevel;
  return `${selection.providerId}/${selection.modelId}${level ? ` (${level})` : ""}`;
}
