import type { ModelMessageContentBlock } from "../deps.js";
import type { ImageDescriptionPort, ResolvedTurnAttachment } from "../types.js";

/**
 * 主模型不支持图片时，用能力模型把图片读成文字（model-selections.md §5）。
 *
 * 触发条件全部收紧：模型能力必须**显式**为 `supportsImage === false`（`undefined` 是未知，
 * 不委派），且必须配置了能力模型端口。描述失败返回 undefined —— 原 image block 原样保留，
 * 后续请求投影会按既有规则把它换成 omitted-media 文本，本轮不失败。
 */
export async function applyCapabilityImageDescription(
  resolved: ResolvedTurnAttachment,
  options: {
    readonly modelInputFormat?: { readonly supportsImage?: boolean };
    readonly imageDescription?: ImageDescriptionPort;
  },
): Promise<ResolvedTurnAttachment> {
  const block = resolved.contentBlock;
  if (block.type !== "image") return resolved;
  if (options.modelInputFormat?.supportsImage !== false) return resolved;
  const describe = options.imageDescription;
  if (!describe) return resolved;
  const description = await describe({
    mediaType: block.mediaType,
    dataUrl: block.dataUrl,
    source: block.source,
  });
  if (!description) return resolved;
  return {
    ...resolved,
    contentBlock: { type: "text", text: buildDescribedImageText(description, block.source) },
    metadata: {
      ...resolved.metadata,
      // 描述文本本身就是可直接投递给 provider 的内容。
      recoverability: "provider_ready",
    },
  };
}

/** 描述文本 + 图片来源引用：主模型据此知道「有一张图」，也能用 Read 工具自己再看一遍。 */
function buildDescribedImageText(
  description: string,
  source: Extract<ModelMessageContentBlock, { type: "image" }>["source"],
): string {
  const path = source?.path ?? source?.placeholder ?? source?.uri;
  return path ? `${description}\n\n[Image: source: ${path}]` : description;
}
