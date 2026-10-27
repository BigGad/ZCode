import { describe, expect, it } from "vitest";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  resolveCapabilityModelSelection,
  resolveConfiguredCapabilityModelSelections,
  type Provider,
  type ProviderRegistryView,
} from "../src/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

/**
 * 能力模型解析（capability-model-selection.md §4）。
 *
 * 能力位取**解析后**的 `properties.inputFormat`，所以这里的 fixture 直接给
 * 解析结果，不走规则文件。
 */
function provider(input: {
  providerId: string;
  modelId: string;
  supportsImage: boolean;
}): Provider {
  return {
    providerId: input.providerId,
    config: createApiKeyProviderConfig({
      apiFormat: "anthropic-messages",
      baseURL: "https://api.example.com",
      apiKey: "test-key",
      models: [input.modelId],
    }),
    models: [
      {
        modelId: input.modelId,
        config: new ModelConfig({
          properties: new ModelPropertiesConfig({
            requiresMfjsToolSchema: false,
            contextWindow: 200_000,
            inputFormat: {
              supportsText: true,
              supportsImage: input.supportsImage,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: true,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          }),
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: { values: ["low", "high"], map: "{}" },
            maxOutputTokens: { max: 32_000, map: "{'max_tokens': maxOutputTokens}" },
          }),
        }),
      },
    ],
  };
}

function registryView(providers: readonly Provider[]): ProviderRegistryView {
  return { revision: 1, providers };
}

describe("能力模型解析", () => {
  const registry = registryView([
    provider({ providerId: "vision", modelId: "vision-model", supportsImage: true }),
    provider({ providerId: "text-only", modelId: "text-model", supportsImage: false }),
  ]);

  it("未配置能力模型时给出 capability-not-configured", () => {
    expect(resolveCapabilityModelSelection({ capability: "image", registry })).toEqual({
      issue: "capability-not-configured",
    });
  });

  it("provider 不存在时给出 provider-not-found", () => {
    expect(
      resolveCapabilityModelSelection({
        capability: "image",
        configured: { image: { providerId: "missing", modelId: "vision-model" } },
        registry,
      }),
    ).toEqual({ issue: "provider-not-found" });
  });

  it("model 不存在时给出 model-not-found", () => {
    expect(
      resolveCapabilityModelSelection({
        capability: "image",
        configured: { image: { providerId: "vision", modelId: "missing" } },
        registry,
      }),
    ).toEqual({ issue: "model-not-found" });
  });

  it("模型不支持图片时给出 capability-not-supported", () => {
    expect(
      resolveCapabilityModelSelection({
        capability: "image",
        configured: { image: { providerId: "text-only", modelId: "text-model" } },
        registry,
      }),
    ).toEqual({ issue: "capability-not-supported" });
  });

  it("解析成功时返回可执行的选择（档位已补齐）", () => {
    expect(
      resolveCapabilityModelSelection({
        capability: "image",
        configured: { image: { providerId: "vision", modelId: "vision-model" } },
        registry,
      }),
    ).toEqual({
      selection: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "low" },
      },
    });
  });

  it("补齐推理档位：缺失时用模型最低公开档位", () => {
    // Model Factory 只接受完整执行选择，缺档位会抛 "Reasoning level is required"。
    expect(
      resolveCapabilityModelSelection({
        capability: "image",
        configured: { image: { providerId: "vision", modelId: "vision-model" } },
        registry,
      }),
    ).toEqual({
      selection: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "low" },
      },
    });
  });

  it("补齐推理档位：配置里显式声明且模型支持时保留", () => {
    expect(
      resolveCapabilityModelSelection({
        capability: "image",
        configured: {
          image: {
            providerId: "vision",
            modelId: "vision-model",
            options: { reasoningLevel: "high" },
          },
        },
        registry,
      }),
    ).toEqual({
      selection: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("补齐推理档位：配置里的档位模型不支持时退回最低公开档位", () => {
    expect(
      resolveCapabilityModelSelection({
        capability: "image",
        configured: {
          image: {
            providerId: "vision",
            modelId: "vision-model",
            options: { reasoningLevel: "unsupported" },
          },
        },
        registry,
      }),
    ).toEqual({
      selection: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "low" },
      },
    });
  });
});

describe("整份能力模型配置解析", () => {
  const registry = registryView([
    provider({ providerId: "vision", modelId: "vision-model", supportsImage: true }),
    provider({ providerId: "text-only", modelId: "text-model", supportsImage: false }),
  ]);

  it("解析失败的能力不进入结果，原因码单独上报", () => {
    const resolved = resolveConfiguredCapabilityModelSelections({
      configured: { image: { providerId: "text-only", modelId: "text-model" } },
      registry,
    });
    expect(resolved.selections).toEqual({});
    expect(resolved.issues).toEqual([{ capability: "image", issue: "capability-not-supported" }]);
  });

  it("解析成功的能力进入结果", () => {
    const resolved = resolveConfiguredCapabilityModelSelections({
      configured: { image: { providerId: "vision", modelId: "vision-model" } },
      registry,
    });
    expect(resolved.selections).toEqual({
      image: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "low" },
      },
    });
    expect(resolved.issues).toEqual([]);
  });

  it("未知能力键保留在配置里但不被消费，也不报错", () => {
    const resolved = resolveConfiguredCapabilityModelSelections({
      configured: { audio: { providerId: "vision", modelId: "vision-model" } },
      registry,
    });
    expect(resolved.selections).toEqual({});
    expect(resolved.issues).toEqual([]);
  });

  it("没有配置时是空结果，不是错误", () => {
    const resolved = resolveConfiguredCapabilityModelSelections({ registry });
    expect(resolved.selections).toEqual({});
    expect(resolved.issues).toEqual([]);
  });
});
