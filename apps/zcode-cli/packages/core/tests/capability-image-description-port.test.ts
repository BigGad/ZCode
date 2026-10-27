import { describe, expect, it, vi } from "vitest";
import { createCapabilityImageDescriptionPort } from "../src/runtime/methods/capability-image-understanding.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * 能力模型图片描述端口（capability-model-selection.md §5.2/§5.3）。
 *
 * 端口是旁路调用：失败（含建不出 Model）必须返回 undefined 让调用方保留原 image block，
 * 不能把整轮带崩。
 */
const SELECTION = { providerId: "vision", modelId: "vision-model" } as const;

function runtime(input: {
  generateText: () => Promise<{ text: string; finishReason: "stop"; usage: undefined }>;
  modelFactory?: () => never;
}): AgentRuntimeInternal {
  return {
    config: { capabilityModelSelections: { image: SELECTION } },
    logger: { info: vi.fn(), warn: vi.fn() },
    modelFactory:
      input.modelFactory ??
      (() =>
        createTestRuntimeModel({
          generateText: input.generateText as never,
        })),
    rootTraceContext: { traceId: "trace_capability" } as never,
  } as unknown as AgentRuntimeInternal;
}

describe("能力模型图片描述端口", () => {
  it("返回能力模型的描述文本", async () => {
    const generateText = vi.fn(async () => ({
      text: "  一张红绿蓝三色横条图  ",
      finishReason: "stop" as const,
      usage: undefined,
    }));
    const port = createCapabilityImageDescriptionPort(runtime({ generateText }), SELECTION, {});

    const description = await port({
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aW1hZ2U=",
    });

    expect(description).toBe("一张红绿蓝三色横条图");
    expect(generateText).toHaveBeenCalledOnce();
    // 能力模型必须真的收到这张图，否则描述无从谈起。
    expect(generateText.mock.calls[0]?.[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: expect.stringContaining("Describe this image.") },
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" },
        ],
      },
    ]);
    // 不进主 loop：能力调用不带工具。
    expect(generateText.mock.calls[0]?.[0]?.tools).toEqual([]);
  });

  it("空响应返回 undefined，调用方保留原 image block", async () => {
    const port = createCapabilityImageDescriptionPort(
      runtime({ generateText: async () => ({ text: "   ", finishReason: "stop" as const, usage: undefined }) }),
      SELECTION,
      {},
    );

    expect(
      await port({ mediaType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }),
    ).toBeUndefined();
  });

  it("建不出 Model 时返回 undefined，不把异常抛给调用方", async () => {
    const warn = vi.fn();
    const failing = {
      config: { capabilityModelSelections: { image: SELECTION } },
      logger: { info: vi.fn(), warn },
      modelFactory: () => {
        throw new Error("Reasoning level is required for vision/vision-model");
      },
      rootTraceContext: { traceId: "trace_capability" } as never,
    } as unknown as AgentRuntimeInternal;
    const port = createCapabilityImageDescriptionPort(failing, SELECTION, {});

    expect(
      await port({ mediaType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("描述调用失败时返回 undefined，不把异常抛给调用方", async () => {
    const warn = vi.fn();
    const failing = {
      config: { capabilityModelSelections: { image: SELECTION } },
      logger: { info: vi.fn(), warn },
      modelFactory: () =>
        createTestRuntimeModel({
          generateText: async () => {
            throw new Error("provider unavailable");
          },
        }),
      rootTraceContext: { traceId: "trace_capability" } as never,
    } as unknown as AgentRuntimeInternal;
    const port = createCapabilityImageDescriptionPort(failing, SELECTION, {});

    expect(
      await port({ mediaType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
