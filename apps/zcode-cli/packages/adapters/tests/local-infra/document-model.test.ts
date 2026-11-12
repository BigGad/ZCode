import { describe, expect, it } from "vitest";
import { readDocumentModelFromValue } from "../../src/local-infra/artifact-store.js";

/**
 * MinerU 结构化产物 → 引擎无关的元素级文档模型。
 *
 * ⚠️ 字段名以 **MinerU 4.1.7 实测产物**为准（`structured_content.json`）：
 * 页在 `pages[]`（`page_idx` / `blocks[]`），块在 `pages[].blocks[]`
 * （`type` / `bbox` / `content` / `image_source`），页级尺寸在
 * `extensions.docvortex_layout.pages[]`，生产者在 `metadata.producer`。
 *
 * ⚠️ 这一层**不做类型白名单** —— 块类型随档位变（`image` ↔ `chart`），
 * 只把引擎给的类型名如实带出来，分类由 core 的积木层做。
 */

/** 一份最小可用的 `structured_content.json`。 */
function structuredContent(): Record<string, unknown> {
  return {
    pages: [
      {
        page_idx: 0,
        blocks: [
          { type: "text", bbox: [10, 20, 300, 40], content: "第一段" },
          { type: "image", bbox: [10, 50, 200, 150], content: "", image_source: "images/p0.jpg" },
          {
            type: "table",
            bbox: [10, 160, 300, 300],
            content: "| a | b |",
            image_source: "images/t.jpg",
          },
        ],
      },
      {
        page_idx: 1,
        blocks: [{ type: "paragraph_title", bbox: [0, 0, 100, 20], content: "标题" }],
      },
    ],
    metadata: { producer: { name: "mineru", version: "4.1.7" } },
    extensions: {
      docvortex_layout: {
        pages: [
          { page_idx: 0, width_pt: 595, height_pt: 842 },
          { page_idx: 1, width_pt: 595, height_pt: 842 },
        ],
      },
    },
  };
}

describe("结构化产物 → 元素级模型", () => {
  it("页号取 page_idx（0 基），页级尺寸取 docvortex_layout", () => {
    const model = readDocumentModelFromValue(structuredContent());
    expect(model?.pages).toHaveLength(2);
    expect(model?.pages[0]?.pageIndex).toBe(0);
    expect(model?.pages[1]?.pageIndex).toBe(1);
    expect(model?.pages[0]?.widthPt).toBe(595);
    expect(model?.pages[0]?.heightPt).toBe(842);
  });

  it("块类型原样带出（不按白名单过滤）", () => {
    const model = readDocumentModelFromValue(structuredContent());
    const types = model?.pages[0]?.elements.map((element) => element.type) ?? [];
    expect(types).toEqual(["text", "image", "table"]);
  });

  it("文本块带文字，图片块的空 content 不产出文字", () => {
    const model = readDocumentModelFromValue(structuredContent());
    const elements = model?.pages[0]?.elements ?? [];
    expect(elements[0]?.text).toBe("第一段");
    expect(elements[1]?.text).toBe("");
  });

  it("image_source 原样保留（相对产物目录）", () => {
    const model = readDocumentModelFromValue(structuredContent());
    expect(model?.pages[0]?.elements[1]?.imagePath).toBe("images/p0.jpg");
    expect(model?.pages[0]?.elements[2]?.imagePath).toBe("images/t.jpg");
  });

  it("绝对 image_source 折成相对产物目录", () => {
    const content = structuredContent();
    const pages = content["pages"] as Array<{ blocks: Array<Record<string, unknown>> }>;
    pages[0]!.blocks[1]!["image_source"] = "/tmp/out/images/p0.jpg";

    const model = readDocumentModelFromValue(content, { artifactsRoot: "/tmp/out" });
    expect(model?.pages[0]?.elements[1]?.imagePath).toBe("images/p0.jpg");
  });

  it("bbox 归一化四元组；不是数组时退化成全 0", () => {
    const content = structuredContent();
    const pages = content["pages"] as Array<{ blocks: Array<Record<string, unknown>> }>;
    pages[0]!.blocks[0]!["bbox"] = ["x", 1, 2, 3];

    const model = readDocumentModelFromValue(content);
    expect(model?.pages[0]?.elements[0]?.bbox).toEqual([0, 1, 2, 3]);

    pages[0]!.blocks[0]!["bbox"] = "nope";
    const second = readDocumentModelFromValue(content);
    expect(second?.pages[0]?.elements[0]?.bbox).toEqual([0, 0, 0, 0]);
  });

  it("content 不是字符串（如 middle_json 的数组形态）时不产出文字", () => {
    const content = structuredContent();
    const pages = content["pages"] as Array<{ blocks: Array<Record<string, unknown>> }>;
    pages[0]!.blocks[0]!["content"] = [{ type: "text", content: "段落" }];

    const model = readDocumentModelFromValue(content);
    expect(model?.pages[0]?.elements[0]?.text).toBeUndefined();
  });

  it("生产者取自 metadata.producer", () => {
    const model = readDocumentModelFromValue(structuredContent());
    expect(model?.producer).toEqual({ name: "mineru", version: "4.1.7" });
  });

  it("没有 pages 时返回 undefined（不是空模型）", () => {
    expect(readDocumentModelFromValue({})).toBeUndefined();
    expect(readDocumentModelFromValue({ pages: "not-an-array" })).toBeUndefined();
    expect(readDocumentModelFromValue(undefined)).toBeUndefined();
  });

  it("没有 docvortex_layout 时页级尺寸为 0（分类不依赖尺寸）", () => {
    const content = structuredContent();
    delete content["extensions"];
    const model = readDocumentModelFromValue(content);
    expect(model?.pages[0]?.widthPt).toBe(0);
    expect(model?.pages[0]?.heightPt).toBe(0);
  });
});
