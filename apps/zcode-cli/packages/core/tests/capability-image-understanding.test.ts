import { describe, expect, it, vi } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { resolveTurnAttachments } from "../src/runtime/helpers/attachments.js";
import type { ImageDescriptionPort } from "../src/runtime/types.js";

/**
 * 能力模型代主模型理解图片（capability-model-selection.md §5）。
 *
 * 委派触发条件只有一条：主模型**显式**不支持图片（`supportsImage === false`）。
 * 能力未知（undefined）不委派，能力模型缺席或失败都保留原 image block。
 */
const INLINE_IMAGE = { type: "image", content: "data:image/png;base64,aW1hZ2U=" } as const;

function artifactStore() {
  return {
    writeToolResultArtifact: vi.fn(async () => ({
      uri: "zcode-artifact://image-1",
      bytes: 10,
      contentType: "image/png",
      createdAt: new Date(),
      id: "image-1",
    })),
  } as never;
}

async function resolve(options: {
  imageDescription?: ImageDescriptionPort;
  modelInputFormat?: { supportsImage?: boolean };
}) {
  const [resolved] = await resolveTurnAttachments([INLINE_IMAGE], {
    artifactStore: artifactStore(),
    ...(options.imageDescription ? { imageDescription: options.imageDescription } : {}),
    ...(options.modelInputFormat ? { modelInputFormat: options.modelInputFormat } : {}),
    sessionId: createSessionId("capability-image"),
    traceContext: { traceId: "trace_capability_image" },
    workingDirectory: "/tmp/project",
  });
  return resolved;
}

describe("能力模型图片理解", () => {
  it("主模型支持图片时不委派，保留原 image block", async () => {
    const imageDescription = vi.fn<ImageDescriptionPort>();
    const resolved = await resolve({
      imageDescription,
      modelInputFormat: { supportsImage: true },
    });

    expect(imageDescription).not.toHaveBeenCalled();
    expect(resolved?.contentBlock.type).toBe("image");
  });

  it("主模型能力未知时不委派", async () => {
    const imageDescription = vi.fn<ImageDescriptionPort>();
    const resolved = await resolve({ imageDescription, modelInputFormat: {} });

    expect(imageDescription).not.toHaveBeenCalled();
    expect(resolved?.contentBlock.type).toBe("image");
  });

  it("主模型显式不支持图片时用能力模型的描述替换 image block", async () => {
    const imageDescription = vi.fn<ImageDescriptionPort>(async () => "一张写着「你好」的白底黑字图片");
    const resolved = await resolve({
      imageDescription,
      modelInputFormat: { supportsImage: false },
    });

    expect(imageDescription).toHaveBeenCalledOnce();
    expect(imageDescription).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: "image/png" }),
    );
    expect(resolved?.contentBlock).toEqual({
      type: "text",
      text: expect.stringContaining("一张写着「你好」的白底黑字图片"),
    });
    // 描述文本之外保留图片来源，主模型需要时可以用 Read 工具自己再看一遍。
    expect(resolved?.contentBlock).toMatchObject({
      type: "text",
      text: expect.stringContaining("[Image: source: attachment-1]"),
    });
    expect(resolved?.metadata.recoverability).toBe("provider_ready");
  });

  it("能力模型失败时保留原 image block，本轮不失败", async () => {
    const imageDescription = vi.fn<ImageDescriptionPort>(async () => undefined);
    const resolved = await resolve({
      imageDescription,
      modelInputFormat: { supportsImage: false },
    });

    expect(imageDescription).toHaveBeenCalledOnce();
    expect(resolved?.contentBlock.type).toBe("image");
  });

  it("没有配置能力模型时保留原 image block", async () => {
    const resolved = await resolve({ modelInputFormat: { supportsImage: false } });

    expect(resolved?.contentBlock.type).toBe("image");
  });
});
