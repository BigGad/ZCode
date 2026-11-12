import type { LocalInfraPort } from "@zcode/contracts";
import { MINERU_DOWNLOADABLE_TIERS } from "@zcode/contracts";
import { buildFailureEnvelope, buildSuccessEnvelope, normalizeLocalInfraError } from "@zcode/core";
import { createReporter, exitCodeForEnvelope, type OcrContext, writeEnvelope } from "./output.js";

/** MinerU 的 `models download --tier` **只接受这两档**（实测 `mineru-kit models download --help`）。 */
const DOWNLOADABLE_TIERS = MINERU_DOWNLOADABLE_TIERS;
type DownloadableTier = (typeof DOWNLOADABLE_TIERS)[number];

/**
 * `zcode ocr models download` —— 下载目标档位的模型权重。
 *
 * ⚠️ **代理剥离只在这个子进程生效**（spec §7.9）：SOCKS 代理会让 MinerU 的 httpx 直接失败
 * （缺 `socksio`）。解析子进程是纯本地推理，不受影响。
 * ⚠️ **档位非法在这里就拦**（`invalid_input` + `details.engineCode = "engine_not_found"`）：
 * 这一条是**引擎自身枚举**（只有 basic / standard），不是端口能力，
 * 端口也判不了「这档能不能下载」。
 */
export async function runModelsDownloadCommand(
  ctx: OcrContext,
  port: LocalInfraPort,
  options: {
    readonly json: boolean;
    readonly tier: string;
    readonly source?: string;
  },
): Promise<number> {
  const reporter = createReporter(ctx, options.json);
  const tier = options.tier.trim();
  if (!isDownloadableTier(tier)) {
    const message = `未知的模型档位：${options.tier}（MinerU 只支持 ${DOWNLOADABLE_TIERS.join("、")}）`;
    return emit(
      ctx,
      options.json,
      buildFailureEnvelope(
        "ocr.models.download",
        {
          code: "invalid_input",
          message,
          details: { engineCode: "engine_not_found" },
        },
        { durationMs: 0, warnings: [] },
      ),
    );
  }

  const source = options.source?.trim();
  reporter.progress("provision", `开始下载模型权重（档位 ${tier}）`);
  const result = await port.downloadModels({
    tier,
    ...(source !== undefined && source !== ""
      ? { source: source as "auto" | "huggingface" | "modelscope" }
      : {}),
  });

  // ⚠️ **进度信息只走 stderr**（验收 A10）：MinerU 的下载输出是人读文本，
  // 既不能混进 stdout 的 JSON，也不该混进人读报告。
  if (result.stdout !== undefined && result.stdout.trim() !== "") {
    reporter.progress("provision", result.stdout.trim());
  }

  if (!result.ok) {
    const error = result.error;
    return emit(
      ctx,
      options.json,
      buildFailureEnvelope(
        "ocr.models.download",
        error !== undefined
          ? normalizeLocalInfraError(error)
          : { code: "internal", message: "模型下载失败，但端口没有给出错误详情" },
        { durationMs: result.durationMs, warnings: result.warnings },
      ),
    );
  }

  reporter.progress("provision", "模型权重下载完成");
  return emit(
    ctx,
    options.json,
    buildSuccessEnvelope(
      "ocr.models.download",
      {
        engine: result.engine ?? "mineru",
        tier: result.tier ?? tier,
      },
      { durationMs: result.durationMs, warnings: result.warnings },
    ),
  );
}

/** 写信封（`--json`）或人读报告，并返回退出码。 */
function emit(
  ctx: OcrContext,
  json: boolean,
  envelope: ReturnType<typeof buildSuccessEnvelope> | ReturnType<typeof buildFailureEnvelope>,
): number {
  if (json) {
    writeEnvelope(ctx, envelope);
  } else {
    writeModelsReport(ctx, envelope);
  }
  return exitCodeForEnvelope(envelope);
}

function writeModelsReport(
  ctx: OcrContext,
  envelope: ReturnType<typeof buildSuccessEnvelope> | ReturnType<typeof buildFailureEnvelope>,
): void {
  const lines: string[] = [];
  if (!envelope.ok) {
    lines.push(`模型下载失败：${envelope.error.message}`);
    if (envelope.error.hint !== undefined) lines.push(`提示：${envelope.error.hint}`);
  } else {
    const tier = envelope.output.tier;
    lines.push(`模型下载完成（档位 ${typeof tier === "string" ? tier : "未知"}）`);
  }
  const warnings = envelope.metrics?.warnings ?? [];
  if (warnings.length > 0) {
    lines.push("告警：");
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }
  const durationMs = envelope.metrics?.durationMs;
  if (typeof durationMs === "number") lines.push(`耗时 ${(durationMs / 1000).toFixed(1)}s`);
  ctx.stdout.write(`${lines.join("\n")}\n`);
}

function isDownloadableTier(value: string): value is DownloadableTier {
  return (DOWNLOADABLE_TIERS as readonly string[]).includes(value);
}
