import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import { generateModelTypeSelections } from "../src/providers-command.js";

/**
 * `zcode providers init` 的类型生成（model-selections.md §7）。
 */

const globalOptions = {
  force: false,
  json: false,
  noColor: true,
  verbose: false,
};

function provider(input: {
  providerId: string;
  modelId: string;
  supportsImage: boolean;
  reasoningLevels?: readonly string[];
}) {
  return {
    providerId: input.providerId,
    models: [
      {
        modelId: input.modelId,
        config: {
          properties: { inputFormat: { supportsImage: input.supportsImage } },
          optionSpecs: {
            reasoningLevel: { values: input.reasoningLevels ?? ["low", "high"] },
          },
        },
      },
    ],
  };
}

test("main 指向当前默认选择，image 指向支持图像的模型", () => {
  const generated = generateModelTypeSelections({
    configuredDefault: {
      providerId: "vision",
      modelId: "vision-model",
      options: { reasoningLevel: "high" },
    },
    providers: [
      provider({ providerId: "vision", modelId: "vision-model", supportsImage: true }),
      provider({ providerId: "text-only", modelId: "text-model", supportsImage: false }),
    ],
  });

  assert.deepEqual(generated, [
    {
      name: "main",
      selection: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "high" },
      },
    },
    {
      name: "image",
      selection: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "high" },
      },
    },
    {
      name: "vision",
      selection: {
        providerId: "vision",
        modelId: "vision-model",
        options: { reasoningLevel: "high" },
      },
    },
    {
      name: "text-only",
      selection: {
        providerId: "text-only",
        modelId: "text-model",
        options: { reasoningLevel: "high" },
      },
    },
  ]);
});

test("没有默认选择时 main 取第一个可选模型", () => {
  const generated = generateModelTypeSelections({
    providers: [provider({ providerId: "solo", modelId: "solo-model", supportsImage: false })],
  });

  assert.equal(generated[0]?.name, "main");
  assert.equal(generated[0]?.selection.providerId, "solo");
  // 默认模型不支持图像时，image 指向别的支持图像的模型；没有则不生成 image。
  assert.equal(
    generated.some((entry) => entry.name === "image"),
    false,
  );
});

test("默认模型支持图像时 image 就是它，不用另找", () => {
  const generated = generateModelTypeSelections({
    configuredDefault: { providerId: "vision", modelId: "vision-model" },
    providers: [
      provider({ providerId: "vision", modelId: "vision-model", supportsImage: true }),
      provider({ providerId: "other", modelId: "other-model", supportsImage: true }),
    ],
  });

  assert.deepEqual(
    generated.find((entry) => entry.name === "image")?.selection.providerId,
    "vision",
  );
});

test("没有可用模型时生成空结果", () => {
  assert.deepEqual(generateModelTypeSelections({ providers: [] }), []);
});
