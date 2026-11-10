import type { LocalInfraPort, LocalParseResult, MineruTier } from "@zcode/contracts";
import {
  exitCodeForError,
  OCR_EXIT_OK,
  type OcrContext,
  toJsonError,
  writeJson,
} from "./output.js";

/**
 * `zcode ocr parse` —— 解析一份本地文档。
 *
 * ⚠️ 档位**原样透传**给端口：合法性由端口判定（内部码 `engine_not_found`），
 * CLI 预校验会让验收 A4 要求的错误形状出不来。
 */
export async function runParseCommand(
  ctx: OcrContext,
  port: LocalInfraPort,
  options: {
    readonly json: boolean;
    readonly path: string;
    readonly output?: string;
    readonly tier?: string;
  },
): Promise<number> {
  const result = await port.parse({
    path: options.path,
    ...(options.output !== undefined ? { outputDir: options.output } : {}),
    ...(options.tier !== undefined
      ? {
          // 端口会在运行时校验档位枚举（§7.6 的 `engine_not_found`），
          // 这里刻意不做预校验，避免同一份校验逻辑出现两个来源。
          tier: options.tier as MineruTier,
        }
      : {}),
  });

  // ⚠️ **进度信息只走 stderr**（验收 A10）：MinerU 自己的 stdout 是人读文本
  // （`已解析 1 个输入。`），**不能混进 stdout 的 JSON**。
  writeEngineProgress(ctx, result.stdout);

  if (options.json) {
    writeJson(ctx, toJsonParseResult(result));
    return result.ok ? OCR_EXIT_OK : exitCodeForError(result.error!);
  }

  writeParseResult(ctx, result);
  return result.ok ? OCR_EXIT_OK : exitCodeForError(result.error!);
}

/** 把引擎的人读输出写到 stderr。 */
function writeEngineProgress(ctx: OcrContext, text: string | undefined): void {
  if (text === undefined || text.trim() === "") return;
  ctx.stderr.write(`${text.trim()}\n`);
}

/** JSON 输出形状：`error.code` 是归一后的能力码，内部码在 `details.engineCode`。 */
export function toJsonParseResult(result: LocalParseResult): Record<string, unknown> {
  return {
    ok: result.ok,
    ...(result.engine !== undefined ? { engine: result.engine } : {}),
    ...(result.tier !== undefined ? { tier: result.tier } : {}),
    ...(result.degradedFrom !== undefined ? { degradedFrom: result.degradedFrom } : {}),
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error !== undefined ? { error: toJsonError(result.error) } : {}),
    warnings: result.warnings,
    durationMs: result.durationMs,
  };
}

function writeParseResult(ctx: OcrContext, result: LocalParseResult): void {
  const lines: string[] = [];
  if (!result.ok && result.error !== undefined) {
    lines.push(`解析失败：${result.error.message}`);
    if (result.error.hint !== undefined) lines.push(`提示：${result.error.hint}`);
  } else {
    lines.push("解析成功");
    if (result.tier !== undefined) {
      const degraded =
        result.degradedFrom !== undefined ? `（原请求 ${result.degradedFrom}，已降级）` : "";
      lines.push(`  档位：${result.tier}${degraded}`);
    }
    const output = result.output;
    if (output !== undefined) {
      lines.push(`  产物目录：${output.outputDir}`);
      if (output.markdownPath !== undefined) lines.push(`  markdown：${output.markdownPath}`);
      if (output.structuredContentPath !== undefined) {
        lines.push(`  结构化内容：${output.structuredContentPath}`);
      }
      if (output.middleJsonPath !== undefined) lines.push(`  中间结果：${output.middleJsonPath}`);
      if (output.assetsDir !== undefined) lines.push(`  图片目录：${output.assetsDir}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("告警：");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push(`耗时 ${(result.durationMs / 1000).toFixed(1)}s`);
  ctx.stdout.write(`${lines.join("\n")}\n`);
}
