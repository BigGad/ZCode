import type { ExecutionEnvOverlay, ExecutionPort } from "@zcode/contracts";
import { PROXY_ENV_KEYS } from "./constants.js";

export interface MineruCliInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly cwd?: string;
  /** 代理策略：`strip` 剥离 shell 代理（默认），`inherit` 保留。 */
  readonly stripProxy?: boolean;
}

export interface MineruCliResult {
  readonly ok: boolean;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  /** 进程无法启动或执行层报错时的说明。 */
  readonly errorMessage?: string;
}

/** 单路输出上限。`models download` 进度输出可能很长，但不需要全文，只需要结尾状态。 */
const INLINE_OUTPUT_LIMIT_BYTES = 256 * 1024;
const BUFFER_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * 调用 MinerU CLI。
 *
 * ⚠️ **永远用绝对路径调用**：`mineru-kit` 是用户机器上的第三方 CLI，用裸名会让
 * PATH 上的同名文件被优先执行。
 */
export async function runMineruCli(
  invocation: MineruCliInvocation,
  execution: ExecutionPort,
  signal?: AbortSignal,
): Promise<MineruCliResult> {
  const env: ExecutionEnvOverlay = {
    base: "inherit",
    ...(invocation.stripProxy === false ? {} : { unset: [...PROXY_ENV_KEYS] }),
  };

  try {
    const result = await execution.run(
      {
        command: {
          mode: "argv",
          file: invocation.executable,
          args: [...invocation.args],
        },
        cwd: invocation.cwd,
        env,
        timeoutMs: invocation.timeoutMs,
        outputLimit: {
          maxInlineBytes: INLINE_OUTPUT_LIMIT_BYTES,
          maxBufferBytes: BUFFER_OUTPUT_LIMIT_BYTES,
          persistOutput: "none",
        },
      },
      { signal },
    );

    return {
      ok: result.status === "completed" && result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      ...(result.error ? { errorMessage: result.error.message } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      durationMs: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 从 stdout 里取 JSON 对象。
 *
 * MinerU 的 `--json` 输出在 stdout 是干净 JSON（日志走 stderr），但工具链里
 * 包一层 wrapper 时前面可能混入 banner，所以再兜一层"截取首个 { 到末个 }"。
 */
export function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;

  const direct = tryParseJsonRecord(trimmed);
  if (direct !== undefined) return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return tryParseJsonRecord(trimmed.slice(start, end + 1));
}

function tryParseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
