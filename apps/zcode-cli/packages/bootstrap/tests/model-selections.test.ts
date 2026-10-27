import { describe, expect, it } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
  type Provider,
} from "@zcode/provider";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

/**
 * 能力模型选择进入 runtimeConfig（model-selections.md §2/§4）。
 *
 * runtimeConfig 里只放**解析成功**的能力选择；解析失败的原因码单独上报，
 * 调用方按「没有能力模型」降级，不影响主链路。
 */
const workingDirectory = "/workspace/app";

function provider(input: {
  providerId: string;
  modelId: string;
  supportsImage: boolean;
}): Provider {
  return {
    providerId: input.providerId,
    config: createApiKeyProviderConfig({
      apiFormat: "openai-chat-completions",
      apiKey: "test-key",
      baseURL: "https://api.example.com",
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

function resolve(input: {
  configuredModelSelections?: Record<string, { providerId: string; modelId: string }>;
  capabilityModelSelectionOverrides?: Record<string, { providerId: string; modelId: string }>;
}) {
  return resolveAppRuntimeConfig({
    cliStorageRoot: "/tmp/zcode-cli",
    configResult: createConfig({ env: {}, skipUserConfig: true, workingDirectory }),
    options: {
      providerRegistry: new ProviderRegistry([
        provider({ providerId: "vision", modelId: "vision-model", supportsImage: true }),
        provider({ providerId: "text-only", modelId: "text-model", supportsImage: false }),
      ]),
      ...(input.configuredModelSelections
        ? { configuredModelSelections: input.configuredModelSelections }
        : {}),
      ...(input.capabilityModelSelectionOverrides
        ? {
            capabilityModelSelectionOverrides: input.capabilityModelSelectionOverrides,
          }
        : {}),
    },
    subagentOutputRootDir: "/tmp/zcode-cli/agents",
    subagentProfiles: [],
    workingDirectory,
  });
}

describe("runtimeConfig 的能力模型选择", () => {
  it("解析成功的能力选择进入 runtimeConfig（档位已补齐）", () => {
    const resolved = resolve({
      configuredModelSelections: {
        image: { providerId: "vision", modelId: "vision-model" },
      },
    });

    expect(resolved.runtimeConfig.capabilityModelSelections).toEqual({
      image: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "low" },
      },
    });
    expect(resolved.capabilityModelSelectionIssues).toEqual([]);
  });

  it("解析失败的能力不进入 runtimeConfig，并给出原因码", () => {
    const resolved = resolve({
      configuredModelSelections: {
        image: { providerId: "text-only", modelId: "text-model" },
      },
    });

    expect(resolved.runtimeConfig.capabilityModelSelections).toEqual({});
    expect(resolved.capabilityModelSelectionIssues).toEqual([
      { capability: "image", issue: "capability-not-supported" },
    ]);
  });

  it("provider 不存在时给出 provider-not-found", () => {
    const resolved = resolve({
      configuredModelSelections: {
        image: { providerId: "missing", modelId: "vision-model" },
      },
    });

    expect(resolved.capabilityModelSelectionIssues).toEqual([
      { capability: "image", issue: "provider-not-found" },
    ]);
  });

  it("没有配置能力模型时是空结果，不是错误", () => {
    const resolved = resolve({});

    expect(resolved.runtimeConfig.capabilityModelSelections).toEqual({});
    expect(resolved.capabilityModelSelectionIssues).toEqual([]);
  });

  it("能力覆盖优先于表里同名能力键的默认绑定", () => {
    const resolved = resolve({
      configuredModelSelections: {
        image: { providerId: "text-only", modelId: "text-model" },
      },
      // 覆盖项已由 CLI 解析成完整选择（档位已补齐）。
      capabilityModelSelectionOverrides: {
        image: {
          providerId: "vision",
          modelId: "vision-model",
          options: { reasoningLevel: "low" },
        },
      },
    });

    expect(resolved.runtimeConfig.capabilityModelSelections).toEqual({
      image: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "low" },
      },
    });
  });

  it("覆盖只影响被覆盖的能力，其余能力仍走默认解析", () => {
    const resolved = resolve({
      configuredModelSelections: {
        image: { providerId: "vision", modelId: "vision-model" },
      },
      capabilityModelSelectionOverrides: {
        image: {
          providerId: "vision",
          modelId: "vision-model",
          options: { reasoningLevel: "high" },
        },
      },
    });

    expect(resolved.runtimeConfig.capabilityModelSelections?.image?.options).toEqual({
      reasoningLevel: "high",
    });
  });
});
