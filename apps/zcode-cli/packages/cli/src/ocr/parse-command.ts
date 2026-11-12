import { dirname, join } from "node:path";
import type { CapabilityEnvelope, FileSystemPort, LocalInfraPort } from "@zcode/contracts";
import { buildSuccessEnvelope } from "@zcode/core";
import { runOcrAnalysis } from "./analysis-flow.js";
import { emitEnvelope, type OcrContext } from "./output.js";

/**
 * `zcode ocr parse` —— 解析一份本地文档（spec：capability-cli-blocks.md §5 / §6）。
 *
 * ⚠️ 档位**原样透传**给端口：合法性由端口判定（内部码 `engine_not_found`），
 * CLI 预校验会让验收 A4 要求的错误形状出不来。
 *
 * ⚠️ **缓存命中时不重跑引擎**（spec §6.5 接力矩阵）—— 这是「业务永远只传原始路径」
 * 的前提（D5）：业务不需要记住上一步的产物路径。
 */
export async function runParseCommand(
  ctx: OcrContext,
  port: LocalInfraPort,
  fileSystem: FileSystemPort,
  options: {
    readonly json: boolean;
    readonly path: string;
    readonly output?: string;
    readonly tier?: string;
    readonly force?: boolean;
    readonly pdfPassword?: string;
  },
): Promise<number> {
  const result = await runOcrAnalysis(ctx, port, fileSystem, options, {
    key: "ocr.parse",
    json: options.json,
    // ⚠️ `parse` 要正文 ⇒ 缓存判据 4 要求 sidecar 的文本类元素带 `text`。
    needsText: true,
    // ⚠️ `parse` 的产物面有 markdown（§5.7 / §5.8）。
    withMarkdown: true,
  });
  if (!result.ok) {
    return emitEnvelope(ctx, options.json, result.envelope, writeParseReport);
  }
  const outcome = result.outcome;
  const envelope = buildSuccessEnvelope(
    "ocr.parse",
    {
      cached: outcome.cached,
      sidecarPath: outcome.sidecarPath,
      artifactsDir: outcome.artifactsDir,
      engine: outcome.engine,
      tier: outcome.tier,
      artifacts: outcome.artifacts,
    },
    {
      durationMs: outcome.durationMs,
      warnings: outcome.warnings,
      ...(outcome.degradedFrom !== undefined ? { degradedFrom: outcome.degradedFrom } : {}),
    },
  );
  return emitEnvelope(ctx, options.json, envelope, writeParseReport);
}

/** 人读报告（非 `--json`）。 */
function writeParseReport(envelope: CapabilityEnvelope): string {
  const lines: string[] = [];
  if (!envelope.ok) {
    lines.push(`解析失败：${envelope.error.message}`);
    if (envelope.error.hint !== undefined) lines.push(`提示：${envelope.error.hint}`);
  } else {
    lines.push("解析成功");
    const output = envelope.output;
    const tier = output.tier;
    if (typeof tier === "string") {
      const degradedFrom = envelope.metrics?.degradedFrom;
      lines.push(
        `  档位：${tier}${degradedFrom !== undefined ? `（原请求 ${degradedFrom}，已降级）` : ""}`,
      );
    }
    const engine = output.engine;
    if (typeof engine === "string") {
      lines.push(`  引擎：${engine}`);
    }
    if (typeof output.cached === "boolean") {
      lines.push(`  缓存：${output.cached ? "命中（未重新识别）" : "未命中"}`);
    }
    const sidecarPath = output.sidecarPath;
    if (typeof sidecarPath === "string") lines.push(`  sidecar：${sidecarPath}`);
    const artifactsDir = output.artifactsDir;
    if (typeof artifactsDir === "string" && typeof sidecarPath === "string") {
      lines.push(`  产物目录：${join(dirname(sidecarPath), artifactsDir)}`);
    }
    const artifacts = output.artifacts;
    if (artifacts !== undefined && typeof artifacts === "object") {
      const references = artifacts as Record<string, unknown>;
      for (const [name, value] of Object.entries(references)) {
        if (typeof value === "string") lines.push(`  ${name}：${value}`);
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
