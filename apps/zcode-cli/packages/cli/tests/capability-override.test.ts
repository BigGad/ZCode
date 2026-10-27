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
  parseCapabilityOverrides,
  resolveCapabilityOverrides,
} from "../src/capability-override.js";

/**
 * 能力覆盖（model-selections.md §6.3）：本次运行里某个能力改指到另一个具名类型。
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
  "image-cheap": { providerId: "vision", modelId: "vision-model" },
  "image-best": { providerId: "vision", modelId: "vision-model", options: { reasoningLevel: "high" } },
  "text-only-type": { providerId: "text-only", modelId: "text-model" },
};

test("解析 <能力键>=<类型名>", () => {
  const parsed = parseCapabilityOverrides(["image=image-cheap"]);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.overrides, [{ capability: "image", typeName: "image-cheap" }]);
});

test("语法不合法时给可操作提示", () => {
  for (const value of ["image", "=image-cheap", "image="]) {
    const parsed = parseCapabilityOverrides([value]);
    assert.match(parsed.error ?? "", /Invalid --capability value/);
  }
});

test("未知能力键被拒绝，并列出可用能力", () => {
  const parsed = parseCapabilityOverrides(["pdf=image-cheap"]);
  assert.equal(parsed.error, "Unknown capability: pdf. Available capabilities: image");
});

test("同一个能力重复给出是配置错误", () => {
  const parsed = parseCapabilityOverrides(["image=a", "image=b"]);
  assert.equal(parsed.error, "Duplicate --capability for image.");
});

test("覆盖项解析成可执行的选择，档位已补齐", () => {
  const resolved = resolveCapabilityOverrides({
    overrides: [{ capability: "image", typeName: "image-cheap" }],
    configured,
    registry,
  });
  assert.equal(resolved.error, undefined);
  assert.deepEqual(resolved.selections?.image, {
    providerId: "vision",
    modelId: "vision-model",
    options: { reasoningLevel: "low" },
  });
});

test("配置里显式声明的档位被保留", () => {
  const resolved = resolveCapabilityOverrides({
    overrides: [{ capability: "image", typeName: "image-best" }],
    configured,
    registry,
  });
  assert.deepEqual(resolved.selections?.image?.options, { reasoningLevel: "high" });
});

test("类型不存在时报错，不静默降级", () => {
  const resolved = resolveCapabilityOverrides({
    overrides: [{ capability: "image", typeName: "nope" }],
    configured,
    registry,
  });
  assert.equal(resolved.selections, undefined);
  assert.equal(
    resolved.error,
    'Capability model type "nope" is not usable for image: model-type-not-configured',
  );
});

test("类型不支持该能力时报错，不静默降级", () => {
  const resolved = resolveCapabilityOverrides({
    overrides: [{ capability: "image", typeName: "text-only-type" }],
    configured,
    registry,
  });
  assert.equal(resolved.selections, undefined);
  assert.equal(
    resolved.error,
    'Capability model type "text-only-type" is not usable for image: capability-not-supported',
  );
});

test("没有覆盖项时是空结果，不是错误", () => {
  const resolved = resolveCapabilityOverrides({ overrides: [], configured, registry });
  assert.equal(resolved.error, undefined);
  assert.deepEqual(resolved.selections, {});
});
