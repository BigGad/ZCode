import type { LocalInfraPort } from "@zcode/contracts";
import {
  exitCodeForError,
  INFR_EXIT_ERROR,
  INFR_EXIT_OK,
  type InfrManageContext,
  toJsonError,
  writeJson,
} from "./output.js";

/** MinerU 的 `models download --tier` **只接受这两档**（实测 `mineru-kit models download --help`）。 */
const DOWNLOADABLE_TIERS = ["basic", "standard"] as const;
type DownloadableTier = (typeof DOWNLOADABLE_TIERS)[number];

/**
 * `zcode-infr-manage models download` —— 下载目标档位的模型权重。
 *
 * ⚠️ **代理剥离只在这个子进程生效**（spec §7.9）：SOCKS 代理会让 MinerU 的 httpx 直接失败
 * （缺 `socksio`）。解析子进程是纯本地推理，不受影响。
 */
export async function runModelsDownloadCommand(
  ctx: InfrManageContext,
  port: LocalInfraPort,
  options: {
    readonly json: boolean;
    readonly tier: string;
    readonly source?: string;
  },
): Promise<number> {
  const tier = options.tier.trim();
  if (!isDownloadableTier(tier)) {
    const message = `未知的模型档位：${options.tier}（MinerU 只支持 ${DOWNLOADABLE_TIERS.join("、")}）`;
    if (options.json) {
      writeJson(ctx, {
        ok: false,
        error: { code: "invalid_input", message, details: { engineCode: "engine_not_found" } },
        warnings: [],
        durationMs: 0,
      });
    } else {
      ctx.stderr.write(`${message}\n`);
    }
    return INFR_EXIT_ERROR;
  }

  const source = options.source?.trim();
  const result = await port.downloadModels({
    tier,
    ...(source !== undefined && source !== ""
      ? { source: source as "auto" | "huggingface" | "modelscope" }
      : {}),
  });

  // ⚠️ **进度信息只走 stderr**（验收 A10）：MinerU 的下载输出是人读文本，
  // 既不能混进 stdout 的 JSON，也不该混进人读报告。
  if (result.stdout !== undefined && result.stdout.trim() !== "") {
    ctx.stderr.write(`${result.stdout.trim()}\n`);
  }

  if (options.json) {
    writeJson(ctx, {
      ok: result.ok,
      ...(result.engine !== undefined ? { engine: result.engine } : {}),
      ...(result.tier !== undefined ? { tier: result.tier } : {}),
      ...(result.error !== undefined ? { error: toJsonError(result.error) } : {}),
      warnings: result.warnings,
      durationMs: result.durationMs,
    });
    return result.ok ? INFR_EXIT_OK : exitCodeForError(result.error!);
  }

  if (!result.ok && result.error !== undefined) {
    ctx.stderr.write(`模型下载失败：${result.error.message}\n`);
    if (result.error.hint !== undefined) ctx.stderr.write(`提示：${result.error.hint}\n`);
  } else {
    ctx.stdout.write(`模型下载完成（档位 ${result.tier}）\n`);
  }
  ctx.stdout.write(`耗时 ${(result.durationMs / 1000).toFixed(1)}s\n`);
  return result.ok ? INFR_EXIT_OK : exitCodeForError(result.error!);
}

function isDownloadableTier(value: string): value is DownloadableTier {
  return (DOWNLOADABLE_TIERS as readonly string[]).includes(value);
}
