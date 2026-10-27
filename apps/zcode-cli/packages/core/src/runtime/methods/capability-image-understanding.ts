import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type { ModelInputMessage, ModelSelection, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ImageDescriptionPort } from "../types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { createRuntimeModel } from "./runtime-model.js";

/**
 * 能力模型代为理解图片（capability-model-selection.md §5）。
 *
 * 只有主模型**显式不支持图片**、且用户配置了 `capabilityModelSelections.image` 时才走这里。
 * 请求复用 `generateText` 的一次性调用路径：不进主 loop、不占主模型的重试预算，
 * 失败时返回 undefined，调用方保留原 image block 并走既有 omitted-media 降级。
 */

const CAPABILITY_IMAGE_DESCRIPTION_TIMEOUT_MS = 60_000;

/** 描述指令固定不变：能力模型只需要「读出这张图」，不需要参与用户任务。 */
const CAPABILITY_IMAGE_DESCRIPTION_PROMPT = [
  "Describe this image.",
  "",
  "Cover, in this order:",
  "1. Every piece of text visible in the image, transcribed verbatim.",
  "2. The main subject and its concrete attributes (objects, people, numbers, names, states).",
  "3. Layout and structure: panels, tables, charts, UI elements, and their spatial relations.",
  "",
  "Reply with the description only — no preamble, no markdown fences, no closing remarks.",
  "Write in the language of the text in the image; if there is no text, use English.",
].join("\n");

function buildCapabilityImageDescriptionMessages(input: {
  readonly mediaType: string;
  readonly dataUrl: string;
}): ModelInputMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: CAPABILITY_IMAGE_DESCRIPTION_PROMPT },
        { type: "image", mediaType: input.mediaType, dataUrl: input.dataUrl },
      ],
    },
  ];
}

/**
 * 取本 runtime 的图片理解端口；没有配置（或配置无效，bootstrap 已过滤）时返回 undefined。
 *
 * 端口是**每回合**新建的：回合的 abortSignal 与 trace 上下文在建端口时绑定，
 * 端口内部不再自行读取 runtime 的可变状态。
 */
export function resolveCapabilityImageDescriptionPort(
  runtime: AgentRuntimeInternal,
  options: { readonly abortSignal?: AbortSignal; readonly traceContext?: TraceContext } = {},
): ImageDescriptionPort | undefined {
  const selection = runtime.config.capabilityModelSelections?.image;
  if (!selection) return undefined;
  return createCapabilityImageDescriptionPort(runtime, selection, options);
}

/**
 * 建一个图片理解端口。端口是**每回合**新建的：回合的 abortSignal 与 trace 上下文
 * 在建端口时绑定，端口内部不再自行读取 runtime 状态。
 */
export function createCapabilityImageDescriptionPort(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
  options: { readonly abortSignal?: AbortSignal; readonly traceContext?: TraceContext } = {},
): ImageDescriptionPort {
  return async (image) => {
    const traceContext = options.traceContext ?? runtime.rootTraceContext;
    const modelTraceContext = traceContext;
    const abortSignal =
      options.abortSignal ?? AbortSignal.timeout(CAPABILITY_IMAGE_DESCRIPTION_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      // Model 创建也在降级边界内：能力模型不可用时本轮退回既有 omitted-media 路径，
      // 不能因为「建不出 Model」让整轮失败。
      const baseModel = createRuntimeModel(runtime, { selection, scope: "workspace" });
      // 描述图片要的是最低公开档位与有限输出预算，不是主模型的完整推理配置。
      const model = baseModel.bind(auxiliaryModelOptions(baseModel));
      const result = await runWithModelInvocationContext(
        {
          metadata: traceContextToLogContext(modelTraceContext),
          modelCall: { operation: "capability_image_understanding" },
          traceContext: modelTraceContext,
        },
        () =>
          model.generateText({
            abortSignal,
            messages: buildCapabilityImageDescriptionMessages({
              mediaType: image.mediaType,
              dataUrl: image.dataUrl,
            }),
            tools: [],
          }),
      );
      const text = result.text.trim();
      if (!text) {
        runtime.logger?.warn("Capability image understanding returned empty text", {
          ...traceContextToLogContext(modelTraceContext),
          event: "capability_image_understanding.failed",
          module: "core.runtime",
          modelProviderId: model.providerId,
          modelId: model.modelId,
          reason: "empty_response",
          status: "failed",
        });
        return undefined;
      }
      runtime.logger?.info("Capability image understanding completed", {
        ...traceContextToLogContext(modelTraceContext),
        event: "capability_image_understanding.completed",
        module: "core.runtime",
        modelProviderId: model.providerId,
        modelId: model.modelId,
        durationMs: Date.now() - startedAt,
        textLength: text.length,
        status: "completed",
      });
      return text;
    } catch (error) {
      runtime.logger?.warn("Capability image understanding failed", {
        ...traceContextToLogContext(modelTraceContext),
        event: "capability_image_understanding.failed",
        module: "core.runtime",
        // 建 Model 失败时还没有 Model 句柄，只能报选择本身。
        modelProviderId: selection.providerId,
        modelId: selection.modelId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
      return undefined;
    }
  };
}
