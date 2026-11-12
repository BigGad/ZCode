import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRootTraceContext, createSessionId, createTurnId } from "@zcode/contracts";
import type { ExecutionPort, ExecutionRequest } from "@zcode/contracts";
import { createPopplerPdfDocumentAdapter } from "../src/pdf/index.js";
import { parsePdftohtmlXml } from "../src/pdf/layout-xml.js";
import { argvOf, completedResult, fakeExecutionPort } from "./local-infra/fixtures.js";

/**
 * PDF 原生版面分析（`pdftohtml -xml`）。
 *
 * ⚠️ **XML 样本是实测产物**（poppler 26.09.0，macOS）—— 判据是「行级合并」与
 * 「绝对坐标减页偏移」，不是猜的格式（spec：capability-cli-blocks.md §6.7）。
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 实测样本：一页两行文字（第一行被拆成三个碎片）+ 一张内嵌图。 */
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<pdf2xml producer="poppler" version="26.09.0">
<page number="1" position="absolute" top="0" left="0" height="841.89" width="595.276">
<text top="16.716" left="69.874" width="52.5" height="11.5" font="Arial">本地</text>
<text top="16.116" left="122.374" width="40.2" height="11.5" font="Arial"> OCR </text>
<text top="16.716" left="162.574" width="60" height="11.5" font="Arial">路线验证</text>
<text top="40.2" left="69.874" width="120" height="11.5" font="Arial">第二行</text>
<image top="100" left="50" width="200" height="150" src="layout-1_1.png"/>
</page>
</pdf2xml>`;

describe("pdftohtml -xml 解析", () => {
  it("把文字碎片合并成行（行级而不是词级）", () => {
    const analysis = parsePdftohtmlXml(SAMPLE_XML, { xmlDirectory: "/tmp/artifacts" });

    expect(analysis.producer).toEqual({ name: "poppler", version: "26.09.0" });
    expect(analysis.pages).toHaveLength(1);
    const page = analysis.pages[0]!;
    expect(page.widthPt).toBeCloseTo(595.276);
    expect(page.heightPt).toBeCloseTo(841.89);
    // ⚠️ **三段碎片合成一行**（同一行的 `top` 差零点几 pt）。
    expect(page.texts.map((text) => text.text)).toEqual(["本地 OCR 路线验证", "第二行"]);
    // 行的 bbox 是碎片的并集。
    expect(page.texts[0]!.bboxPt[0]).toBeCloseTo(69.874);
    expect(page.texts[0]!.bboxPt[1]).toBeCloseTo(16.116);
    expect(page.texts[0]!.bboxPt[2]).toBeCloseTo(222.574);
    expect(page.texts[0]!.bboxPt[3]).toBeCloseTo(28.216);
  });

  it("内嵌图的 bbox 与路径都落在页内坐标里", () => {
    const analysis = parsePdftohtmlXml(SAMPLE_XML, { xmlDirectory: "/tmp/artifacts" });

    const image = analysis.pages[0]!.images[0]!;
    expect(image.bboxPt).toEqual([50, 100, 250, 250]);
    // ⚠️ `src` 相对 XML 所在目录解析。
    expect(image.imagePath).toBe(join("/tmp/artifacts", "layout-1_1.png"));
  });

  it("绝对坐标减去页自身的偏移", () => {
    const xml = `<pdf2xml producer="poppler" version="26.09.0">
<page number="2" position="absolute" top="100" left="50" height="200" width="300">
<text top="110" left="60" width="40" height="10" font="Arial">偏移</text>
</page>
</pdf2xml>`;

    const analysis = parsePdftohtmlXml(xml, { xmlDirectory: "/tmp/artifacts" });

    expect(analysis.pages[0]!.texts[0]!.bboxPt).toEqual([10, 10, 50, 20]);
  });

  it("空白碎片被丢掉（排版噪声）", () => {
    const xml = `<pdf2xml producer="poppler" version="26.09.0">
<page number="1" position="absolute" top="0" left="0" height="200" width="300">
<text top="10" left="10" width="40" height="10" font="Arial">   </text>
<text top="30" left="10" width="40" height="10" font="Arial">正文</text>
</page>
</pdf2xml>`;

    const analysis = parsePdftohtmlXml(xml, { xmlDirectory: "/tmp/artifacts" });

    expect(analysis.pages[0]!.texts.map((text) => text.text)).toEqual(["正文"]);
  });
});

describe("PDF 适配器的原生版面分析", () => {
  it("用固定的 pdftohtml argv 调一次，解析产物并给出生产者版本", async () => {
    const outputDir = await temporaryRoot();
    const executionPort = fakeExecutionPort(async (request: ExecutionRequest) => {
      const args = argvOf(request);
      if (args.includes("-v")) return completedResult();
      // ⚠️ poppler 把 XML 写到最后一个参数（输出路径）。
      await writeFile(args.at(-1)!, SAMPLE_XML);
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort });

    const analysis = await adapter.analyzeLayout({
      filePath: "/tmp/report.pdf",
      outputDir,
      trace: trace(),
    });

    expect(analysis.producer.version).toBe("26.09.0");
    expect(analysis.pages[0]!.texts[0]!.text).toBe("本地 OCR 路线验证");
    // ⚠️ **一次调用**同时给出页尺寸 / 文本 bbox / 图片 bbox（spec §6.7）。
    const analysisCall = executionPort.calls.find((request) => argvOf(request).includes("-xml"));
    expect(analysisCall?.command).toEqual({
      mode: "argv",
      file: "pdftohtml",
      args: [
        "-xml",
        "-zoom",
        "1",
        "-noroundcoord",
        "-hidden",
        "-nodrm",
        "-q",
        "/tmp/report.pdf",
        join(outputDir, "layout.xml"),
      ],
    });
  });

  it("密码只经 argv 传给子进程", async () => {
    const outputDir = await temporaryRoot();
    const executionPort = fakeExecutionPort(async (request: ExecutionRequest) => {
      const args = argvOf(request);
      if (args.includes("-v")) return completedResult();
      await writeFile(args.at(-1)!, SAMPLE_XML);
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort });

    await adapter.analyzeLayout({
      filePath: "/tmp/report.pdf",
      outputDir,
      password: "s3cret",
      trace: trace(),
    });

    const analysisCall = executionPort.calls.find((request) => argvOf(request).includes("-xml"));
    const args = argvOf(analysisCall!);
    expect(args).toContain("-upw");
    expect(args[args.indexOf("-upw") + 1]).toBe("s3cret");
  });

  it("poppler 不可用时抛 unavailable（调用方据此退到识别路线）", async () => {
    const outputDir = await temporaryRoot();
    const executionPort: ExecutionPort = {
      async run() {
        return {
          status: "spawn_error",
          exitCode: 1,
          stdout: { text: "", bytes: 0, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          error: { type: "spawn_error", message: "spawn pdftohtml ENOENT" },
        };
      },
    } as unknown as ExecutionPort;
    const adapter = createPopplerPdfDocumentAdapter({ executionPort });

    await expect(
      adapter.analyzeLayout({ filePath: "/tmp/report.pdf", outputDir, trace: trace() }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-layout-"));
  roots.push(root);
  return root;
}

function trace() {
  const sessionId = createSessionId("pdf-layout");
  return createRootTraceContext({ sessionId, turnId: createTurnId("pdf-layout") });
}
