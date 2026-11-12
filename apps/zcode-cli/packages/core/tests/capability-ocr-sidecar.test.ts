import { describe, expect, it } from "vitest";
import type {
  LocalDocumentElement,
  LocalDocumentPage,
  LocalInfraErrorCode,
  OcrSidecar,
} from "@zcode/contracts";
import { CAPABILITY_ERROR_CODES, OCR_SIDECAR_VERSION } from "@zcode/contracts";
import {
  buildFailureEnvelope,
  buildOcrSidecar,
  buildSuccessEnvelope,
  classifyOcrElementType,
  computeOcrPageComposition,
  deriveOcrMarkdown,
  evaluateOcrSidecarCache,
  exitCodeForCapabilityError,
  normalizeLocalInfraError,
  ocrSidecarLocationFor,
  OCR_ELEMENT_TYPE_CATEGORIES,
} from "../src/capability/index.js";

/**
 * 能力积木层的纯逻辑（spec：`docs/design/v2/capability-cli-blocks.md` §5 / §6）。
 *
 * ⚠️ 这一层**不碰 IO** —— 读产物、算指纹、落盘都在命令面与 adapter，
 * 所以这里全是纯函数用例。
 */

function element(type: string, extra: Partial<LocalDocumentElement> = {}): LocalDocumentElement {
  return { type, bbox: [0, 0, 1, 1], ...extra };
}

function page(elements: LocalDocumentElement[], pageIndex = 0): LocalDocumentPage {
  return { pageIndex, widthPt: 595, heightPt: 842, status: "ok", elements };
}

/** 组一个可命中的 sidecar（默认内容满足「需要逐元素文字」）。 */
function sidecar(overrides: Partial<OcrSidecar> = {}): OcrSidecar {
  return buildOcrSidecar({
    source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
    engine: {
      name: "mineru",
      variant: "mineru",
      version: "4.1.7",
      tier: "basic",
      route: "mineru",
      assets: {},
    },
    artifactsDir: "a.pdf.mineru",
    pages: [page([element("text", { text: "正文" })])],
    ...overrides,
  });
}

describe("元素分类（spec §6.4）", () => {
  it("映射表覆盖已知的引擎类型名", () => {
    expect(classifyOcrElementType("text")).toBe("text");
    expect(classifyOcrElementType("paragraph_title")).toBe("text");
    expect(classifyOcrElementType("table")).toBe("text");
    expect(classifyOcrElementType("image")).toBe("image");
    expect(classifyOcrElementType("chart")).toBe("image");
    expect(classifyOcrElementType("page")).toBe("image");
  });

  it("表里没有的一律 other —— 不静默吞掉", () => {
    expect(classifyOcrElementType("equation")).toBe("other");
    expect(classifyOcrElementType("")).toBe("other");
  });

  it("原型链上的键不会被误当成已知类型", () => {
    // ⚠️ `type = "constructor"` 撞原型链 ⇒ 必须用 hasOwn 判定。
    expect(classifyOcrElementType("constructor")).toBe("other");
    expect(classifyOcrElementType("toString")).toBe("other");
  });

  it("映射表本身不含 other（other 是兜底，不是表里的一行）", () => {
    expect(Object.values(OCR_ELEMENT_TYPE_CATEGORIES)).not.toContain("other");
  });
});

describe("页成分判定（spec §6.4 的 8 行全枚举）", () => {
  const text = element("text", { text: "t" });
  const image = element("image");
  const other = element("equation");

  it.each([
    [[], "empty", 0],
    [[other], "other", 1],
    [[text], "text", 0],
    [[text, other], "text", 1],
    [[image], "image", 0],
    [[image, other], "image", 1],
    [[text, image], "text+image", 0],
    [[text, image, other], "text+image", 1],
  ])("%j ⇒ %s（未归类计数 %i）", (elements, composition, otherElements) => {
    const result = computeOcrPageComposition(elements as LocalDocumentElement[]);
    expect(result.composition).toBe(composition);
    expect(result.otherElements).toBe(otherElements);
  });

  it("未归类元素只进计数，不污染 composition", () => {
    const result = computeOcrPageComposition([text, other]);
    expect(result.composition).toBe("text");
    expect(result.otherElements).toBe(1);
  });
});

describe("sidecar 组装", () => {
  it("版本是 3，产物目录相对 sidecar 目录", () => {
    const built = sidecar();
    expect(built.version).toBe(OCR_SIDECAR_VERSION);
    expect(built.version).toBe(3);
    expect(built.artifactsDir).toBe("a.pdf.mineru");
  });

  it("文本类元素恒带 text（空串也算），图片类不带 text", () => {
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "mineru",
        variant: "mineru",
        version: "4.1.7",
        tier: "basic",
        route: "mineru",
        assets: {},
      },
      artifactsDir: "out",
      pages: [
        page([
          element("text"),
          element("image", { imagePath: "images/p0.jpg", text: "引擎不该给图片文本" }),
        ]),
      ],
    });
    const elements = built.pages[0]?.elements ?? [];
    expect(elements[0]?.text).toBe("");
    expect(elements[1]?.text).toBeUndefined();
    expect(elements[1]?.imagePath).toBe("images/p0.jpg");
  });

  it("失败页的 composition 是 null（≠ 空白页）", () => {
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "mineru",
        variant: "mineru",
        version: "4.1.7",
        tier: "basic",
        route: "mineru",
        assets: {},
      },
      artifactsDir: "out",
      pages: [{ pageIndex: 2, widthPt: 0, heightPt: 0, status: "failed", elements: [] }],
    });
    expect(built.pages[0]?.status).toBe("failed");
    expect(built.pages[0]?.composition).toBeNull();
    expect(built.pages[0]?.elements).toEqual([]);
  });

  it("markdown 路径相对 artifactsDir", () => {
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "mineru",
        variant: "mineru",
        version: "4.1.7",
        tier: "basic",
        route: "mineru",
        assets: {},
      },
      artifactsDir: "out",
      pages: [page([element("text", { text: "正文" })])],
      markdownPath: "a.md",
    });
    expect(built.text?.markdownPath).toBe("a.md");
  });
});

describe("sidecar 落盘位置", () => {
  it("是源文件旁的 <源文件名>.zcode-ocr.json（含扩展名）", () => {
    const location = ocrSidecarLocationFor("/tmp/work/report.pdf");
    expect(location.path).toBe("/tmp/work/report.pdf.zcode-ocr.json");
    expect(location.directory).toBe("/tmp/work");
  });
});

describe("缓存判据（spec §6.5）", () => {
  const criteria = { sourceSha256: "abc", needsText: true };

  it("四条判据全满足才命中", () => {
    const decision = evaluateOcrSidecarCache(sidecar(), criteria);
    expect(decision.hit).toBe(true);
    expect(decision.tier).toBe("basic");
  });

  it("没有 sidecar ⇒ 未命中", () => {
    const decision = evaluateOcrSidecarCache(undefined, criteria);
    expect(decision.hit).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  it("版本不对 ⇒ 未命中", () => {
    const decision = evaluateOcrSidecarCache({ ...sidecar(), version: 2 as never }, criteria);
    expect(decision.hit).toBe(false);
  });

  it("源文件内容变了 ⇒ 未命中（mtime 不参与判定）", () => {
    const decision = evaluateOcrSidecarCache(sidecar(), { ...criteria, sourceSha256: "changed" });
    expect(decision.hit).toBe(false);
    expect(decision.reason).toContain("源文件内容已变化");
  });

  it("请求的档位与 sidecar 不一致 ⇒ 未命中", () => {
    const decision = evaluateOcrSidecarCache(sidecar(), { ...criteria, tier: "standard" });
    expect(decision.hit).toBe(false);
    expect(decision.reason).toContain("档位");
  });

  it("请求没给档位 ⇒ 命中任意档位，但报告实际档位", () => {
    const decision = evaluateOcrSidecarCache(sidecar(), criteria);
    expect(decision.hit).toBe(true);
    expect(decision.tier).toBe("basic");
  });

  it("原生分析路线没有质量档位 ⇒ 档位判据不适用（v2.3 例外）", () => {
    // ⚠️ 原生路线不烧权重，档位对它没有意义 ⇒ 照字面执行判据会让数字版 PDF
    // 每次都「档位不符 ⇒ 重算」，缓存形同虚设（spec §6.5 判据 3 的 v2.3 例外）。
    const native = sidecar({
      engine: {
        name: "pdf-native",
        variant: "pdf-native",
        version: "26.09.0",
        tier: "native",
        route: "pdf-native",
        assets: {},
      },
    });

    const decision = evaluateOcrSidecarCache(native, { ...criteria, tier: "basic" });
    expect(decision.hit).toBe(true);
    expect(decision.tier).toBe("native");
  });

  it("需要文字但文本元素没有 text ⇒ 未命中", () => {
    const broken = {
      ...sidecar(),
      pages: [
        {
          ...sidecar().pages[0]!,
          elements: [
            {
              category: "text" as const,
              type: "text",
              bbox: [0, 0, 1, 1] as [number, number, number, number],
            },
          ],
        },
      ],
    };
    const decision = evaluateOcrSidecarCache(broken, criteria);
    expect(decision.hit).toBe(false);
    expect(decision.reason).toContain("逐元素文字");
  });

  it("不需要文字时（inspect）没有 text 也算命中", () => {
    const broken = {
      ...sidecar(),
      pages: [
        {
          ...sidecar().pages[0]!,
          elements: [
            {
              category: "text" as const,
              type: "text",
              bbox: [0, 0, 1, 1] as [number, number, number, number],
            },
          ],
        },
      ],
    };
    const decision = evaluateOcrSidecarCache(broken, { sourceSha256: "abc", needsText: false });
    expect(decision.hit).toBe(true);
  });

  it("空 sidecar（没有页）⇒ 未命中", () => {
    const decision = evaluateOcrSidecarCache({ ...sidecar(), pages: [] }, criteria);
    expect(decision.hit).toBe(false);
  });
});

describe("markdown 派生（spec §6.5）", () => {
  it("文本类出文字，图片类出图引用，页间空一行", () => {
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "mineru",
        variant: "mineru",
        version: "4.1.7",
        tier: "basic",
        route: "mineru",
        assets: {},
      },
      artifactsDir: "out",
      pages: [
        page(
          [element("text", { text: "第一页" }), element("image", { imagePath: "images/p0.jpg" })],
          0,
        ),
        page([element("text", { text: "第二页" })], 1),
      ],
    });
    const markdown = deriveOcrMarkdown(built);
    expect(markdown).toContain("第一页");
    expect(markdown).toContain("![](images/p0.jpg)");
    expect(markdown).toContain("第二页");
    expect(markdown).toContain("\n\n");
  });

  it("空页不产出内容", () => {
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "mineru",
        variant: "mineru",
        version: "4.1.7",
        tier: "basic",
        route: "mineru",
        assets: {},
      },
      artifactsDir: "out",
      pages: [page([])],
    });
    expect(deriveOcrMarkdown(built)).toBe("");
  });
});

describe("统一信封（spec §5）", () => {
  it("成功信封带 version / key / ok / output", () => {
    const envelope = buildSuccessEnvelope("ocr.parse", { cached: false }, { durationMs: 12 });
    expect(envelope.version).toBe(1);
    expect(envelope.key).toBe("ocr.parse");
    expect(envelope.ok).toBe(true);
    expect(envelope.output).toEqual({ cached: false });
    expect(envelope.metrics?.durationMs).toBe(12);
  });

  it("失败信封带 error 而不是 output", () => {
    const envelope = buildFailureEnvelope("ocr.parse", {
      code: "invalid_input",
      message: "档位非法",
    });
    expect(envelope.ok).toBe(false);
    expect("output" in envelope).toBe(false);
    expect(envelope.error.code).toBe("invalid_input");
  });
});

describe("错误归一（spec §5.2）", () => {
  it("引擎内部码单向归一到 8 个能力码，原始码留在 engineCode", () => {
    expect(normalizeLocalInfraError({ code: "engine_not_found", message: "m" }).code).toBe(
      "invalid_input",
    );
    expect(normalizeLocalInfraError({ code: "engine_unavailable", message: "m" }).code).toBe(
      "unavailable",
    );
    expect(normalizeLocalInfraError({ code: "process_failed", message: "m" }).code).toBe(
      "internal",
    );
    expect(normalizeLocalInfraError({ code: "artifact_missing", message: "m" }).code).toBe(
      "internal",
    );
    expect(normalizeLocalInfraError({ code: "timeout", message: "m" }).code).toBe("timeout");
    expect(normalizeLocalInfraError({ code: "input_invalid", message: "m" }).code).toBe(
      "not_found",
    );
    expect(
      normalizeLocalInfraError({
        code: "input_invalid",
        message: "m",
        details: { reason: "unsupported_input" },
      }).code,
    ).toBe("unsupported_input");
    // ⚠️ 加密 PDF 是**输入前提不满足**，不是引擎故障 ⇒ invalid_input（spec：ocr-local.md §3.2.1）。
    expect(normalizeLocalInfraError({ code: "password_protected", message: "m" }).code).toBe(
      "invalid_input",
    );
  });

  it("归一时保留 engineCode 与原始 details", () => {
    const normalized = normalizeLocalInfraError({
      code: "process_failed",
      message: "引擎执行失败",
      hint: "CUDA out of memory",
      details: { exitCode: 3 },
    });
    expect(normalized.code).toBe("internal");
    expect(normalized.hint).toBe("CUDA out of memory");
    expect(normalized.details?.engineCode).toBe("process_failed");
    expect(normalized.details?.exitCode).toBe(3);
  });
});

describe("退出码（spec §5.2）", () => {
  it("只有超时与取消特殊，其余都是 1", () => {
    expect(exitCodeForCapabilityError("timeout")).toBe(124);
    expect(exitCodeForCapabilityError("cancelled")).toBe(130);
    expect(exitCodeForCapabilityError("invalid_input")).toBe(1);
    expect(exitCodeForCapabilityError("unavailable")).toBe(1);
    expect(exitCodeForCapabilityError("not_found")).toBe(1);
    expect(exitCodeForCapabilityError("unsupported_input")).toBe(1);
    expect(exitCodeForCapabilityError("permission_denied")).toBe(1);
    expect(exitCodeForCapabilityError("internal")).toBe(1);
  });
});

describe("错误码闭集（spec §10.1）", () => {
  it("对外错误码恰好 8 个，没有第 9 个", () => {
    expect(CAPABILITY_ERROR_CODES).toHaveLength(8);
    expect(new Set(CAPABILITY_ERROR_CODES).size).toBe(8);
    expect([...CAPABILITY_ERROR_CODES].sort()).toEqual([
      "cancelled",
      "internal",
      "invalid_input",
      "not_found",
      "permission_denied",
      "timeout",
      "unavailable",
      "unsupported_input",
    ]);
  });

  it("每个引擎内部码的归一结果都落在闭集内（闭集外一律是契约破坏）", () => {
    const engineCodes: LocalInfraErrorCode[] = [
      "engine_not_found",
      "engine_unavailable",
      "process_failed",
      "artifact_missing",
      "timeout",
      "input_invalid",
      "password_protected",
      "document_corrupted",
      "permission_denied",
    ];

    for (const engineCode of engineCodes) {
      const normalized = normalizeLocalInfraError({ code: engineCode, message: "m" });
      expect(CAPABILITY_ERROR_CODES).toContain(normalized.code);
      // ⚠️ 引擎码只出现在 `details.engineCode`（业务按能力码分支，运维按内部码定位）。
      expect(normalized.details?.engineCode).toBe(engineCode);
    }
  });
});

describe("sidecar 的位置与格式（spec §6.2 / §10.2）", () => {
  it("数字版空白页 ⇒ status: ok + composition: empty（不是 failed）", () => {
    // ⚠️ **失败页 ≠ 空白页**：分析出错的页是 failed + composition null；
    // 数字版 PDF 原生分析不出元素是 ok + empty（spec §10.2）。
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "pdf-native",
        variant: "pdf-native",
        version: "26.09.0",
        tier: "native",
        route: "pdf-native",
        assets: {},
      },
      artifactsDir: "out",
      pages: [page([])],
    });

    expect(built.pages[0]?.status).toBe("ok");
    expect(built.pages[0]?.composition).toBe("empty");
    expect(built.pages[0]?.elements).toEqual([]);
  });

  it("bbox 是归一化四元组，分母是页级 widthPt / heightPt（逐页对应）", () => {
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "mineru",
        variant: "mineru",
        version: "4.1.7",
        tier: "basic",
        route: "mineru",
        assets: {},
      },
      artifactsDir: "out",
      pages: [
        {
          pageIndex: 0,
          widthPt: 595,
          heightPt: 842,
          status: "ok",
          elements: [element("text", { bbox: [0.1, 0.2, 0.3, 0.4], text: "x" })],
        },
        {
          pageIndex: 1,
          widthPt: 1190,
          heightPt: 842,
          status: "ok",
          elements: [element("text", { bbox: [0.05, 0.05, 0.95, 0.09], text: "y" })],
        },
      ],
    });

    // ⚠️ **分母是页级的**（不是整份文档共用一个）⇒ 两页的尺寸各自独立。
    expect(built.pages[0]?.widthPt).toBe(595);
    expect(built.pages[1]?.widthPt).toBe(1190);
    expect(built.pages[0]?.elements[0]?.bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(built.pages[1]?.elements[0]?.bbox).toEqual([0.05, 0.05, 0.95, 0.09]);
  });

  it("扫描页的整页图保留 origin: rendered 与 bbox [0,0,1,1]", () => {
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "mineru",
        variant: "mineru",
        version: "4.1.7",
        tier: "basic",
        route: "mineru",
        assets: {},
      },
      artifactsDir: "out",
      pages: [
        page([element("image", { origin: "rendered", bbox: [0, 0, 1, 1], imagePath: "page.png" })]),
      ],
    });

    expect(built.pages[0]?.elements[0]?.origin).toBe("rendered");
    expect(built.pages[0]?.elements[0]?.bbox).toEqual([0, 0, 1, 1]);
    expect(built.pages[0]?.elements[0]?.imagePath).toBe("page.png");
  });

  it("格式稳定 —— sidecar 里不出现 MinerU 专有键，元素 type 保持开放字符串", () => {
    const built = buildOcrSidecar({
      source: { path: "a.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
      engine: {
        name: "mineru",
        variant: "mineru",
        version: "4.1.7",
        tier: "basic",
        route: "mineru",
        assets: {},
      },
      artifactsDir: "out",
      pages: [page([element("equation", { text: "E=mc^2" })])],
    });

    // ⚠️ **引擎专有键不许漏进统一格式**（`extensions.mineru` / `docvortex_layout`）。
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain("extensions");
    expect(serialized).not.toContain("docvortex_layout");
    // ⚠️ `type` 是开放字符串 —— 新类型名原样保留，分类归到 other。
    expect(built.pages[0]?.elements[0]?.type).toBe("equation");
    expect(built.pages[0]?.elements[0]?.category).toBe("other");
  });
});
