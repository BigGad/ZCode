import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { OcrSidecarSchema } from "@zcode/contracts";
import { createNodeFileSystemAdapter } from "../src/fs/index.js";

/**
 * sidecar 的落盘侧契约（spec：`docs/design/v2/capability-cli-blocks.md` §6.2 / §6.6）。
 *
 * ⚠️ **命令面只负责把 `atomic: true` 传下去**（见 `packages/cli/tests/ocr-sidecar-store.test.ts`），
 * 真正让「并发读者永远读到完整 JSON」成立的是**文件系统适配器** —— 这一层就是它的落点。
 *
 * ⚠️ **路径基准写死**（§6.2）：`artifactsDir` 相对 **sidecar 所在目录**；
 * `elements[].imagePath` 与 `text.markdownPath` 相对 **`artifactsDir`**。
 */

interface SidecarPayload {
  readonly version: 3;
  readonly source: { path: string; sha256: string; bytes: number; mtimeMs: number };
  readonly engine: {
    name: string;
    variant: string;
    version: string;
    tier: string;
    route: string;
    assets: Record<string, unknown>;
  };
  readonly artifactsDir: string;
  readonly pages: unknown[];
  readonly text?: { markdownPath: string };
  /** 只给本用例用：标记这一份 payload 的身份（用来判断读者读到的是不是完整的一份）。 */
  readonly marker: string;
}

/** 造一份 sidecar（形状对齐 §6.2 的 v3）。 */
function sidecarPayload(marker: string, artifactsDir = "report.pdf.mineru"): SidecarPayload {
  return {
    version: 3,
    source: { path: "report.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
    engine: {
      name: "mineru",
      variant: "mineru",
      version: "4.1.7",
      tier: "basic",
      route: "mineru",
      assets: {},
    },
    artifactsDir,
    pages: [
      {
        pageIndex: 0,
        widthPt: 595,
        heightPt: 842,
        status: "ok",
        composition: "text+image",
        otherElements: 0,
        elements: [
          { category: "text", type: "text", bbox: [0.1, 0.2, 0.3, 0.4], text: "正文" },
          {
            category: "image",
            type: "image",
            bbox: [0.3, 0.4, 0.7, 0.8],
            imagePath: "images/p0.jpg",
          },
        ],
      },
    ],
    text: { markdownPath: "report.md" },
    marker,
  };
}

describe("sidecar 的原子写（spec §6.6）", () => {
  it("并发读者永远读到完整的 JSON（不会读到半截）", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-sidecar-atomic-"));
    const fileSystem = createNodeFileSystemAdapter();
    const sidecarPath = join(directory, "report.pdf.zcode-ocr.json");

    try {
      const payloads = [sidecarPayload("A"), sidecarPayload("B")];
      await fileSystem.writeTextFile({
        path: sidecarPath,
        content: `${JSON.stringify(payloads[0], null, 2)}\n`,
        atomic: true,
        createParents: true,
      });

      let stop = false;
      const observations: string[] = [];
      const reader = (async () => {
        while (!stop) {
          try {
            const content = (await fileSystem.readTextFile({ path: sidecarPath })).content;
            const parsed = JSON.parse(content) as { marker?: unknown };
            observations.push(typeof parsed.marker === "string" ? parsed.marker : "broken");
          } catch {
            // ⚠️ 读到半截 JSON ⇒ 记成 broken，断言阶段会失败。
            observations.push("broken");
          }
        }
      })();

      for (let index = 0; index < 60; index += 1) {
        const payload = payloads[index % payloads.length]!;
        await fileSystem.writeTextFile({
          path: sidecarPath,
          content: `${JSON.stringify(payload, null, 2)}\n`,
          atomic: true,
        });
      }

      stop = true;
      await reader;

      expect(observations.length).toBeGreaterThan(0);
      expect(observations.filter((marker) => marker === "broken")).toEqual([]);
      // 读到的每一份都是完整的一份（A 或 B）。
      expect([...new Set(observations)].sort()).toEqual(["A", "B"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("落盘后能被统一 schema 校验（写出来的就是 v3 格式）", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-sidecar-schema-"));
    const fileSystem = createNodeFileSystemAdapter();
    const sidecarPath = join(directory, "report.pdf.zcode-ocr.json");

    try {
      await fileSystem.writeTextFile({
        path: sidecarPath,
        content: `${JSON.stringify(sidecarPayload("A"), null, 2)}\n`,
        atomic: true,
        createParents: true,
      });

      const content = (await fileSystem.readTextFile({ path: sidecarPath })).content;
      const parsed = OcrSidecarSchema.safeParse(JSON.parse(content));
      expect(parsed.success).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("sidecar 的路径基准（spec §6.2）", () => {
  it("artifactsDir 相对 sidecar 目录；imagePath 与 markdownPath 相对 artifactsDir", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-sidecar-paths-"));
    const fileSystem = createNodeFileSystemAdapter();
    const sidecarPath = join(directory, "report.pdf.zcode-ocr.json");
    const artifactsDir = "report.pdf.mineru";

    try {
      // 造真实的产物：产物目录与图片、markdown 都在 sidecar 旁边。
      const artifactsRoot = join(directory, artifactsDir);
      await mkdir(join(artifactsRoot, "images"), { recursive: true });
      await fileSystem.writeTextFile({
        path: join(artifactsRoot, "images", "p0.jpg"),
        content: "JPEG-BYTES",
        atomic: true,
        createParents: true,
      });
      await fileSystem.writeTextFile({
        path: join(artifactsRoot, "report.md"),
        content: "# 正文\n",
        atomic: true,
        createParents: true,
      });
      await fileSystem.writeTextFile({
        path: sidecarPath,
        content: `${JSON.stringify(sidecarPayload("A", artifactsDir), null, 2)}\n`,
        atomic: true,
        createParents: true,
      });

      const content = (await fileSystem.readTextFile({ path: sidecarPath })).content;
      const sidecar = OcrSidecarSchema.parse(JSON.parse(content));

      // ⚠️ **基准 1**：`artifactsDir` 相对 sidecar 所在目录。
      const resolvedArtifacts = join(dirname(sidecarPath), sidecar.artifactsDir);
      expect(resolvedArtifacts).toBe(artifactsRoot);
      expect((await stat(resolvedArtifacts)).isDirectory()).toBe(true);

      // ⚠️ **基准 2**：`elements[].imagePath` 相对 `artifactsDir`。
      const imagePath = sidecar.pages[0]?.elements[1]?.imagePath;
      expect(imagePath).toBe("images/p0.jpg");
      const resolvedImage = join(resolvedArtifacts, imagePath ?? "");
      expect((await stat(resolvedImage)).isFile()).toBe(true);

      // ⚠️ **基准 3**：`text.markdownPath` 相对 `artifactsDir`。
      expect(sidecar.text?.markdownPath).toBe("report.md");
      const resolvedMarkdown = join(resolvedArtifacts, sidecar.text?.markdownPath ?? "");
      expect((await stat(resolvedMarkdown)).isFile()).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
