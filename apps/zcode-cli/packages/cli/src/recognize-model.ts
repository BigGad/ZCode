import { parseModelPickerValue, type ModelSelection } from "@zcode/shared/model-selection";

/**
 * `zcode recognize` 的模型选择（image-recognition-cli.md「Model Selection」节）。
 *
 * 四级优先，全部可解释：
 *  1. `--model <providerId>/<modelId>[$reasoningLevel]`（Picker 串，复用 `parseModelPickerValue`）；
 *  2. 能力模型配置 `capabilityModelSelections.image`（capability-model-selection.md §6），
 *     即用户显式声明的「图片理解用这个模型」；
 *  3. 会话已配置的默认选择**且**它支持图像输入；
 *  4. provider registry 快照里第一个支持图像输入的模型。
 *
 * 第 4 级不写字面量模型 id：能力位来自 registry 解析结果
 * （`packages/provider/src/resolver.ts` 的 `ProviderModel.config.properties.inputFormat`），
 * 内置模型表变化时选择自动跟着变。都挑不出来时抛错——报「没有视觉模型」比伪造一个
 * 不存在的模型 id、让 provider 在请求期才失败更接近事实。
 */

/** 从 registry 快照提取的候选，只留选择所需字段，避免把 provider 类型泄漏到命令层。 */
export interface ImageModelCandidate {
  providerId: string;
  modelId: string;
  supportsImage: boolean;
}

export const NO_VISION_MODEL_MESSAGE =
  "No image-capable model found. Pass --model <providerId>/<modelId> explicitly.";

export function pickRecognizeModelSelection(input: {
  explicit?: string;
  configuredCapability?: ModelSelection;
  configuredDefault?: ModelSelection;
  candidates: readonly ImageModelCandidate[];
}): ModelSelection {
  const explicit = input.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    // Picker 串的解析错误（缺 `/`、空 id）原样上抛：这是用户输入问题，不该被兜底吞掉。
    return parseModelPickerValue(explicit);
  }

  // 能力模型必须真的存在且支持图像输入；配置里写错的模型 id 不能把识别带偏。
  const configuredCapability = input.configuredCapability;
  if (
    configuredCapability !== undefined &&
    candidateSupportsImage(
      input.candidates,
      configuredCapability.providerId,
      configuredCapability.modelId,
    )
  ) {
    return configuredCapability;
  }

  const configuredDefault = input.configuredDefault;
  if (
    configuredDefault !== undefined &&
    candidateSupportsImage(input.candidates, configuredDefault.providerId, configuredDefault.modelId)
  ) {
    return configuredDefault;
  }

  const firstImageCapable = input.candidates.find((candidate) => candidate.supportsImage);
  if (firstImageCapable === undefined) {
    throw new Error(NO_VISION_MODEL_MESSAGE);
  }
  return { providerId: firstImageCapable.providerId, modelId: firstImageCapable.modelId };
}

function candidateSupportsImage(
  candidates: readonly ImageModelCandidate[],
  providerId: string,
  modelId: string,
): boolean {
  return candidates.some(
    (candidate) =>
      candidate.providerId === providerId && candidate.modelId === modelId && candidate.supportsImage,
  );
}
