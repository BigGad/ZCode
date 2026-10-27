import { describe, expect, it } from "vitest";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  resolveCapabilityModelSelections,
  resolveModelTypeSelection,
  type Provider,
  type ProviderRegistryView,
} from "../src/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

/**
 * 命名模型类型解析（model-selections.md §4）。
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

const registry = registryView([
  provider({ providerId: "vision", modelId: "vision-model", supportsImage: true }),
  provider({ providerId: "text-only", modelId: "text-model", supportsImage: false }),
]);

describe("命名模型类型解析", () => {
  it("类型名不存在时给出 model-type-not-configured", () => {
    expect(resolveModelTypeSelection({ name: "fast", registry })).toEqual({
      issue: "model-type-not-configured",
    });
  });

  it("provider 不存在时给出 provider-not-found", () => {
    expect(
      resolveModelTypeSelection({
        name: "fast",
        configured: { fast: { providerId: "missing", modelId: "vision-model" } },
        registry,
      }),
    ).toEqual({ issue: "provider-not-found" });
  });

  it("model 不存在时给出 model-not-found", () => {
    expect(
      resolveModelTypeSelection({
        name: "fast",
        configured: { fast: { providerId: "vision", modelId: "missing" } },
        registry,
      }),
    ).toEqual({ issue: "model-not-found" });
  });

  it("解析成功时返回可执行的选择（档位已补齐）", () => {
    expect(
      resolveModelTypeSelection({
        name: "fast",
        configured: { fast: { providerId: "vision", modelId: "vision-model" } },
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
      resolveModelTypeSelection({
        name: "fast",
        configured: {
          fast: {
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
      resolveModelTypeSelection({
        name: "fast",
        configured: {
          fast: {
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

  it("人点名的类型不校验能力：文本模型也可以被点名", () => {
    expect(
      resolveModelTypeSelection({
        name: "fast",
        configured: { fast: { providerId: "text-only", modelId: "text-model" } },
        registry,
      }),
    ).toEqual({
      selection: {
        providerId: "text-only",
        modelId: "text-model",
        options: { reasoningLevel: "low" },
      },
    });
  });
});

describe("能力键的模型选择解析", () => {
  it("解析失败的能力不进入结果，原因码单独上报", () => {
    const resolved = resolveCapabilityModelSelections({
      configured: { image: { providerId: "text-only", modelId: "text-model" } },
      registry,
    });
    expect(resolved.selections).toEqual({});
    expect(resolved.issues).toEqual([{ capability: "image", issue: "capability-not-supported" }]);
  });

  it("解析成功的能力进入结果", () => {
    const resolved = resolveCapabilityModelSelections({
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

  it("未知类型名保留在配置里但不被消费，也不报错", () => {
    const resolved = resolveCapabilityModelSelections({
      configured: { audio: { providerId: "vision", modelId: "vision-model" } },
      registry,
    });
    expect(resolved.selections).toEqual({});
    expect(resolved.issues).toEqual([]);
  });

  it("没有配置时是空结果，不是错误", () => {
    const resolved = resolveCapabilityModelSelections({ registry });
    expect(resolved.selections).toEqual({});
    expect(resolved.issues).toEqual([]);
  });
});
