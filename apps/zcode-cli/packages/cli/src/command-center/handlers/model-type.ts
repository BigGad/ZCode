import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { listAppEffortOptions } from "../effort-options.js";
import { rememberCurrentModelSelection } from "../model-selection.js";
import type { CommandCenterDeps } from "../types.js";

/**
 * `/model-type <名字>`：按**命名模型类型**切模型（model-selections.md §6）。
 *
 * 与 `/model <provider/model>` 的区别：`/model` 从 Registry 目录里挑任意模型，
 * `/model-type` 只能挑用户在 Personal Provider Config 的 `modelSelections` 里命名过的类型。
 * 两者落到同一次「切换并保存默认选择」的流程。
 */
export async function handleModelTypeCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const current = app.getModel?.();
  const types = (await deps.listModelTypes?.()) ?? [];
  const name = args.trim();

  if (!name || name === "list") {
    return {
      mode: deps.getMode?.(),
      model: current,
      response: formatModelTypeList(types),
      thoughtLevel: app.getThoughtLevel?.(),
    };
  }

  const option = types.find((candidate) => candidate.name === name);
  if (!option) {
    // 未知类型只给提示，不退出 TUI：用户还能改用 /model 选目录里的模型。
    return {
      mode: deps.getMode?.(),
      model: current,
      response: `Unknown model type: ${name}. ${formatModelTypeList(types)}`,
      thoughtLevel: app.getThoughtLevel?.(),
    };
  }

  if (!app.setModel) {
    return {
      mode: deps.getMode?.(),
      response: "Model selection is not available in this client.",
    };
  }

  try {
    const result = await app.setModel(option.selection);
    const persistenceWarning = await rememberCurrentModelSelection(app, deps);
    const effortOptions = await listAppEffortOptions(app);
    return {
      ...(effortOptions ? { effortOptions } : {}),
      mode: deps.getMode?.(),
      model: result.model,
      modelOptions: app.listModels ? await app.listModels() : undefined,
      loginRequired: false,
      response: `Model type "${option.name}" switched to ${result.model}.${persistenceWarning}`,
      thoughtLevel: result.thoughtLevel ?? app.getThoughtLevel?.(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: deps.getMode?.(),
      response: `Unable to switch model type: ${message}`,
      model: current,
      thoughtLevel: app.getThoughtLevel?.(),
    };
  }
}

function formatModelTypeList(types: readonly { name: string; selection: ModelSelection }[]): string {
  if (types.length === 0) {
    return "No named model types are configured. Add modelSelections to your Personal Provider Config.";
  }
  const lines = types.map(
    (option) =>
      `- ${option.name} (${option.selection.providerId}/${option.selection.modelId})`,
  );
  return ["Available model types:", ...lines, "Use /model-type <name> to switch."].join("\n");
}
