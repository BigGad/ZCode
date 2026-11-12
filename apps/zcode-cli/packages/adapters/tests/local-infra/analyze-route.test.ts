import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PdfDocumentPortError,
  createRootTraceContext,
  createSessionId,
  createTurnId,
  type LocalParseResult,
  type PdfDocumentPort,
  type PdfLayoutAnalysis,
} from "@zcode/contracts";
import {
  NATIVE_ANALYSIS_ENGINE,
  NATIVE_ANALYSIS_TIER,
  POPPLER_MISSING_WARNING,
  analyzeDocument,
  decideAnalysisRoute,
} from "../../src/local-infra/analyze.js";

/**
 * 分析路线自决（spec：capability-cli-blocks.md §3.1 / §6.7）。
 *
 * ⚠️ **判据是「每一页都有文本层」** —— 只要有一页没有，整份文档就走识别路线
 * （引擎的输入是整份文档，逐页混排会让页号对不上）。
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function trace() {
  const sessionId = createSessionId("analyze-route");
  return createRootTraceContext({ sessionId, turnId: createTurnId("analyze-route") });
}

function analysisWith(pages: PdfLayoutAnalysis["pages"]): PdfLayoutAnalysis {
  return { pages, producer: { name: "poppler", version: "26.09.0" } };
}

function textPage(pageIndex: number): PdfLayoutAnalysis["pages"][number] {
  return {
    pageIndex,
    widthPt: 595,
    heightPt: 842,
    texts: [{ text: `第 ${pageIndex + 1} 页`, bboxPt: [10, 10, 100, 24] }],
    images: [],
  };
}

describe("路线判定", () => {
  it("每一页都有文本层 ⇒ 原生分析路线", () => {
    const decision = decideAnalysisRoute(analysisWith([textPage(0), textPage(1)]));

    expect(decision.route).toBe("pdf-native");
    expect(decision.reason).toContain("原生分析");
  });

  it("有一页没有文本层 ⇒ 识别路线（宁可多算，不可漏页）", () => {
    const decision = decideAnalysisRoute(
      analysisWith([
        textPage(0),
        { pageIndex: 1, widthPt: 595, heightPt: 842, texts: [], images: [] },
      ]),
    );

    expect(decision.route).toBe("mineru");
    expect(decision.reason).toContain("1 页没有文本层");
  });

  it("没有 poppler ⇒ 识别路线，并说明多付权重代价", () => {
    const decision = decideAnalysisRoute(undefined);

    expect(decision.route).toBe("mineru");
    expect(decision.reason).toBe(POPPLER_MISSING_WARNING);
  });
});

describe("走「路线自决」的解析", () => {
  it("原生分析路线给出逐元素模型，图片路径相对产物目录", async () => {
    const outputDir = await temporaryRoot();
    const pdf = pdfPortWith({
      analyzeLayout: async () =>
        analysisWith([
          {
            pageIndex: 0,
            widthPt: 595,
            heightPt: 842,
            texts: [{ text: "标题", bboxPt: [59.5, 14.2, 224.6, 25.7] }],
            images: [{ bboxPt: [50, 100, 250, 250], imagePath: join(outputDir, "layout-1_1.png") }],
          },
        ]),
    });
    const engineCalls: string[] = [];

    const result = await analyzeDocument(
      {
        pdf,
        parseWithEngine: async (request) => {
          engineCalls.push(request.path);
          return engineResult();
        },
      },
      { path: "/tmp/report.pdf", outputDir, route: "auto" },
    );

    expect(result.ok).toBe(true);
    expect(result.route).toBe("pdf-native");
    expect(engineCalls).toHaveLength(0);
    const page = result.output?.documentModel?.pages[0]!;
    // ⚠️ bbox 归一化到页尺寸（分母是 pt）。
    expect(page.elements[0]!.bbox[0]).toBeCloseTo(0.1);
    expect(page.elements[0]!.text).toBe("标题");
    expect(page.elements[1]!.imagePath).toBe("layout-1_1.png");
    expect(result.output?.documentModel?.producer?.name).toBe(NATIVE_ANALYSIS_ENGINE);
  });

  it("扫描页（没有文本但有内嵌图）补一张整页图，来源是 rendered", async () => {
    const outputDir = await temporaryRoot();
    const pdf = pdfPortWith({
      analyzeLayout: async () =>
        analysisWith([
          {
            pageIndex: 0,
            widthPt: 595,
            heightPt: 842,
            texts: [],
            images: [{ bboxPt: [0, 0, 595, 842], imagePath: join(outputDir, "layout-1_1.png") }],
          },
        ]),
      renderPages: async (request) => [
        { data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg", pageNumber: request.firstPage },
      ],
    });

    const result = await analyzeDocument(
      { pdf, parseWithEngine: async () => engineResult() },
      { path: "/tmp/scan.pdf", outputDir, route: "auto" },
    );

    expect(result.ok).toBe(true);
    // ⚠️ 扫描页 ⇒ 整份文档走识别路线（引擎参与）。
    expect(result.route).toBe("mineru");
    const page = result.output?.documentModel?.pages[0]!;
    const rendered = page.elements.find((element) => element.origin === "rendered");
    expect(rendered?.type).toBe("page");
    expect(rendered?.bbox).toEqual([0, 0, 1, 1]);
    expect(rendered?.imagePath).toBe("images/page-1.jpg");
  });

  it("poppler 不可用 ⇒ 退到识别路线，并给出明确告警", async () => {
    const outputDir = await temporaryRoot();
    const pdf = pdfPortWith({
      analyzeLayout: async () => {
        throw new PdfDocumentPortError("unavailable", "pdftohtml is not available.");
      },
    });

    const result = await analyzeDocument(
      { pdf, parseWithEngine: async () => engineResult() },
      { path: "/tmp/report.pdf", outputDir, route: "auto" },
    );

    expect(result.ok).toBe(true);
    expect(result.route).toBe("mineru");
    expect(result.warnings).toContain(POPPLER_MISSING_WARNING);
  });

  it("密码被拒 ⇒ 直接报错，不退到识别路线（退过去只是多烧一次权重）", async () => {
    const outputDir = await temporaryRoot();
    const pdf = pdfPortWith({
      analyzeLayout: async () => {
        throw new PdfDocumentPortError("password_protected", "PDF is password-protected.");
      },
    });
    let engineCalled = false;

    const result = await analyzeDocument(
      {
        pdf,
        parseWithEngine: async () => {
          engineCalled = true;
          return engineResult();
        },
      },
      { path: "/tmp/report.pdf", outputDir, route: "auto", password: "wrong" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("password_protected");
    expect(engineCalled).toBe(false);
  });
});

/** 假 PDF 端口（只实现本组用到的几个方法）。 */
function pdfPortWith(overrides: Partial<PdfDocumentPort>): PdfDocumentPort {
  return {
    async getPageCount() {
      return undefined;
    },
    async renderPages() {
      return [];
    },
    async decryptToFile() {
      throw new Error("未实现：decryptToFile");
    },
    async analyzeLayout() {
      throw new Error("未实现：analyzeLayout");
    },
    ...overrides,
  } as PdfDocumentPort;
}

/** 识别路线的引擎结果（带元素级模型）。 */
function engineResult(): LocalParseResult {
  return {
    ok: true,
    engine: "mineru",
    tier: "basic",
    output: {
      outputDir: "/tmp/report.pdf.mineru",
      documentModel: {
        pages: [
          {
            pageIndex: 0,
            widthPt: 595,
            heightPt: 842,
            status: "ok",
            elements: [{ type: "text", bbox: [0.1, 0.1, 0.5, 0.2], text: "引擎给的文字" }],
          },
        ],
        producer: { name: "mineru", version: "4.1.7" },
      },
    },
    warnings: [],
    durationMs: 5,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-analyze-route-"));
  roots.push(root);
  return root;
}
