import { dirname, join } from "node:path";
import type {
  CapabilityEnvelope,
  FileSystemPort,
  LocalInfraPort,
  OcrSidecarPage,
} from "@zcode/contracts";
import { buildSuccessEnvelope } from "@zcode/core";
import { runOcrAnalysis } from "./analysis-flow.js";
import { emitEnvelope, type OcrContext } from "./output.js";

// ============================================================
// `zcode ocr inspect` —— 页成分 + 元素位置（**不返回文字正文**）
// ============================================================
//
// ⚠️ **输出里没有元素文字**（spec §5.8）：这是 `inspect` 与 `parse` 的唯一区别。
// ⚠️ **但 sidecar 里仍然带逐元素文字** ⇒ `parse` 能接力，不必重跑引擎（§6.5 的接力矩阵）。

/**
 * `zcode ocr inspect` —— 只出页成分 + 元素位置。
 *
 * ⚠️ **不产出 markdown** —— 那是 `parse` 的产物（§5.8）。
 */
export async function runInspectCommand(
  ctx: OcrContext,
  port: LocalInfraPort,
  fileSystem: FileSystemPort,
  options: {
    readonly json: boolean;
    readonly path: string;
    readonly output?: string;
    readonly force?: boolean;
    readonly pdfPassword?: string;
  },
): Promise<number> {
  const result = await runOcrAnalysis(ctx, port, fileSystem, options, {
    key: "ocr.inspect",
    json: options.json,
    // ⚠️ `inspect` 不需要逐元素文字（缓存判据 4 的 `inspect` 行）。
    needsText: false,
    // ⚠️ `inspect` 不产出 markdown。
    withMarkdown: false,
  });
  if (!result.ok) {
    return emitEnvelope(ctx, options.json, result.envelope, writeInspectReport);
  }
  const outcome = result.outcome;
  const envelope = buildSuccessEnvelope(
    "ocr.inspect",
    {
      cached: outcome.cached,
      sidecarPath: outcome.sidecarPath,
      artifactsDir: outcome.artifactsDir,
      engine: outcome.engine,
      tier: outcome.tier,
      pages: outcome.pages.map(toInspectPage),
    },
    {
      durationMs: outcome.durationMs,
      warnings: outcome.warnings,
      ...(outcome.degradedFrom !== undefined ? { degradedFrom: outcome.degradedFrom } : {}),
    },
  );
  return emitEnvelope(ctx, options.json, envelope, writeInspectReport);
}

/**
 * 页对象 → `inspect` 的输出形状。
 *
 * ⚠️ **元素的 `text` 字段不出现**（spec §5.8）—— 只给分类、类型、来源、位置与图片路径。
 */
function toInspectPage(page: OcrSidecarPage): Record<string, unknown> {
  return {
    pageIndex: page.pageIndex,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    status: page.status,
    composition: page.composition,
    otherElements: page.otherElements,
    elements: page.elements.map((element) => ({
      category: element.category,
      type: element.type,
      origin: element.origin ?? "engine",
      bbox: element.bbox,
      ...(element.imagePath !== undefined ? { imagePath: element.imagePath } : {}),
    })),
  };
}

/** 人读报告（非 `--json`）。 */
function writeInspectReport(envelope: CapabilityEnvelope): string {
  const lines: string[] = [];
  if (!envelope.ok) {
    lines.push(`版面分析失败：${envelope.error.message}`);
    if (envelope.error.hint !== undefined) lines.push(`提示：${envelope.error.hint}`);
  } else {
    lines.push("版面分析成功");
    const output = envelope.output;
    if (typeof output.cached === "boolean") {
      lines.push(`  缓存：${output.cached ? "命中（未重新分析）" : "未命中"}`);
    }
    if (typeof output.engine === "string") {
      lines.push(`  引擎：${output.engine}`);
    }
    if (typeof output.tier === "string") {
      lines.push(`  档位：${output.tier}`);
    }
    const sidecarPath = output.sidecarPath;
    if (typeof sidecarPath === "string") lines.push(`  sidecar：${sidecarPath}`);
    const artifactsDir = output.artifactsDir;
    if (typeof artifactsDir === "string" && typeof sidecarPath === "string") {
      lines.push(`  产物目录：${join(dirname(sidecarPath), artifactsDir)}`);
    }
    const pages = output.pages;
    if (Array.isArray(pages)) {
      lines.push(`  页数：${pages.length}`);
      for (const page of pages) {
        if (!isPageSummary(page)) continue;
        const other = page.otherElements > 0 ? `，未归类 ${page.otherElements} 个` : "";
        lines.push(
          `    第 ${page.pageIndex + 1} 页：${page.composition ?? "（分析失败）"}（元素 ${page.elements.length} 个${other}）`,
        );
      }
    }
  }
  const warnings = envelope.metrics?.warnings ?? [];
  if (warnings.length > 0) {
    lines.push("告警：");
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }
  const durationMs = envelope.metrics?.durationMs;
  if (typeof durationMs === "number") lines.push(`耗时 ${(durationMs / 1000).toFixed(1)}s`);
  return `${lines.join("\n")}\n`;
}

/** 人读报告里的页摘要（`output.pages[]` 的运行时形状）。 */
interface PageSummary {
  readonly pageIndex: number;
  readonly composition: string | null;
  readonly otherElements: number;
  readonly elements: readonly unknown[];
}

function isPageSummary(value: unknown): value is PageSummary {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Partial<PageSummary>;
  return (
    typeof page.pageIndex === "number" &&
    typeof page.elements === "object" &&
    page.elements !== null
  );
}
