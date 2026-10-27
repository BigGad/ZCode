import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type Provider,
  type ProviderRegistryView,
} from "@zcode/provider";
import {
  formatUnknownModelTypeMessage,
  listModelTypeNames,
  listModelTypeOptions,
  resolveRequestedModelType,
} from "../src/model-type.js";

/**
 * 命名模型类型的解析与选择（model-selections.md §6）。
 */
function provider(input: {
  providerId: string;
  modelId: string;
  supportsImage: boolean;
}): Provider {
  return {
    providerId: input.providerId,
    config: new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
      api: new ProviderApiConfig({
        type: "anthropic-messages",
        baseUrl: "https://api.example.com",
      }),
      builtinModelIds: [input.modelId],
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

const registry: ProviderRegistryView = {
  revision: 1,
  providers: [
    provider({ providerId: "vision", modelId: "vision-model", supportsImage: true }),
    provider({ providerId: "text-only", modelId: "text-model", supportsImage: false }),
  ],
};

const configured = {
  fast: { providerId: "text-only", modelId: "text-model" },
  image: { providerId: "vision", modelId: "vision-model" },
  main: { providerId: "vision", modelId: "vision-model", options: { reasoningLevel: "high" } },
};

test("类型名按字典序列出", () => {
  assert.deepEqual(listModelTypeNames(configured), ["fast", "image", "main"]);
  assert.deepEqual(listModelTypeNames(undefined), []);
});

test("只列出解析成功的类型", () => {
  const options = listModelTypeOptions({
    configured: { ...configured, broken: { providerId: "missing", modelId: "x" } },
    registry,
  });
  assert.deepEqual(
    options.map((option) => option.name),
    ["fast", "image", "main"],
  );
});

test("没点名时没有选择，也没有错误", () => {
  assert.deepEqual(resolveRequestedModelType({ registry }), {});
  assert.deepEqual(resolveRequestedModelType({ name: "  ", registry }), {});
});

test("点名的类型解析成带档位的完整选择", () => {
  const resolved = resolveRequestedModelType({ name: "fast", configured, registry });
  assert.deepEqual(resolved.error, undefined);
  assert.deepEqual(resolved.selection, {
    providerId: "text-only",
    modelId: "text-model",
    options: { reasoningLevel: "low" },
  });
});

test("配置里显式声明的档位被保留", () => {
  const resolved = resolveRequestedModelType({ name: "main", configured, registry });
  assert.deepEqual(resolved.selection?.options, { reasoningLevel: "high" });
});

test("类型名不存在时给可操作提示，列出配置里实际存在的类型", () => {
  const resolved = resolveRequestedModelType({ name: "nope", configured, registry });
  assert.equal(resolved.selection, undefined);
  assert.equal(
    resolved.error,
    "Unknown model type: nope. Available types: fast, image, main",
  );
});

test("没有配置任何类型时提示为空列表", () => {
  const resolved = resolveRequestedModelType({ name: "nope", registry });
  assert.equal(resolved.error, "Unknown model type: nope. Available types: (none)");
  assert.equal(formatUnknownModelTypeMessage("x", []), "Unknown model type: x. Available types: (none)");
});
