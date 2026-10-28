import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  validateMemoV30,
  type MemoV30Violation,
  type MemoV30ValidationResult,
} from "@zcode/shared/memo-v30";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";

/**
 * `zcode memo validate <file.json>` —— v3.0 阅卷笔录契约的**产出侧校验**。
 *
 * ## 为什么要有它
 *
 * v3.0 契约（`docs/design/v2/v30-memo.schema.json`）的跨字段规则（CF-01~08）
 * **JSON Schema 表达不了** → 只照结构实现会被宿主整卷拒。
 * 以前这条规则只在**宿主侧**（导出 Word 时）才拦 → 产出侧的人/agent 只能人肉核对。
 * 这个命令把同一批规则**提前**到产出侧：写完就验，别等导出。
 *
 * ## 退出码
 *
 * - `0` 通过（**含软违**：CF-08 只记不拒）
 * - `1` 有硬违，或结构不合法
 * - `2` 文件读不到 / 不是合法 JSON
 */

/** 退出码：文件读不到或不是合法 JSON。 */
export const MEMO_EXIT_IO_ERROR = 2;
/** 退出码：有硬违或结构不合法。 */
export const MEMO_EXIT_INVALID = 1;
/** 退出码：通过（含软违）。 */
export const MEMO_EXIT_OK = 0;

const USAGE = `用法:
  zcode memo validate <file.json>

校验一份 v3.0 阅卷笔录 JSON（契约：docs/design/v2/v30-memo.schema.json）。
退出码：0 通过（含软违） / 1 有硬违或结构不合法 / 2 文件读不到或不是合法 JSON。
`;

const SUBCOMMAND_USAGE_ERROR = "zcode memo needs a subcommand: validate.";
const FILE_REQUIRED_ERROR = "zcode memo validate needs a file path.";

/** 注入点：测试用（默认真读文件）。 */
export interface MemoCommandDependencies {
  /** 读文本文件；抛错即视为「读不到」。 */
  readonly readTextFile?: (filePath: string) => Promise<string>;
  /** 相对路径的基准目录（缺省 = 进程 cwd）。 */
  readonly workingDirectory?: string;
}

export async function runMemoCommand(
  ctx: RunContext,
  options: GlobalOptions,
  positionals: readonly string[],
  deps: MemoCommandDependencies = {},
): Promise<number> {
  const subcommand = positionals[0];
  if (subcommand === undefined) {
    ctx.stderr.write(`${SUBCOMMAND_USAGE_ERROR}\n\n${USAGE}`);
    return MEMO_EXIT_INVALID;
  }
  if (subcommand !== "validate") {
    ctx.stderr.write(`Unknown memo subcommand: ${subcommand}\n\n${USAGE}`);
    return MEMO_EXIT_INVALID;
  }

  const rawPath = positionals[1]?.trim();
  if (rawPath === undefined || rawPath.length === 0) {
    ctx.stderr.write(`${FILE_REQUIRED_ERROR}\n\n${USAGE}`);
    return MEMO_EXIT_INVALID;
  }

  const base = deps.workingDirectory ?? process.cwd();
  const filePath = path.resolve(base, rawPath);

  let text: string;
  try {
    text = await (deps.readTextFile ?? readFile)(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Cannot read "${filePath}": ${message}\n`);
    return MEMO_EXIT_IO_ERROR;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`"${filePath}" is not valid JSON: ${message}\n`);
    return MEMO_EXIT_IO_ERROR;
  }

  const result = validateMemoV30(raw);
  const asJson = options.json === true || options.outputFormat === "json";
  if (asJson) {
    ctx.stdout.write(`${JSON.stringify(buildJsonPayload(filePath, result), null, 2)}\n`);
  } else {
    ctx.stdout.write(formatTextReport(filePath, result));
  }
  return result.ok ? MEMO_EXIT_OK : MEMO_EXIT_INVALID;
}

/** `--json` 时的载荷形状。 */
export function buildJsonPayload(
  filePath: string,
  result: MemoV30ValidationResult,
): Record<string, unknown> {
  return {
    file: filePath,
    ok: result.ok,
    structureIssues: [...result.structureIssues],
    violations: result.violations.map(toJsonViolation),
    warnings: result.warnings.map(toJsonViolation),
  };
}

function toJsonViolation(violation: MemoV30Violation): Record<string, unknown> {
  return {
    id: violation.id,
    kind: violation.kind,
    hard: violation.hard,
    detail: violation.detail,
    hint: violation.hint,
    ...(violation.seq === undefined ? {} : { seq: violation.seq }),
  };
}

/** 文本报告（人读）。 */
export function formatTextReport(filePath: string, result: MemoV30ValidationResult): string {
  const lines: string[] = [];
  const hardCount = result.violations.length;
  const warnCount = result.warnings.length;
  const structureCount = result.structureIssues.length;

  if (result.ok) {
    lines.push(`${filePath}：通过（0 处硬违${warnCount > 0 ? `，${warnCount} 条软警告` : ""}）`);
  } else {
    lines.push(`${filePath}：不通过（${hardCount} 处硬违，${structureCount} 条结构问题）`);
  }

  if (structureCount > 0) {
    lines.push("", `结构问题 ${structureCount} 条：`);
    for (const issue of result.structureIssues) {
      lines.push(`  · ${issue}`);
    }
  }

  if (hardCount > 0) {
    lines.push("", `硬违 ${hardCount} 条：`);
    for (const violation of result.violations) {
      lines.push(`  [${violation.id}] ${violation.detail}`);
      lines.push(`      → ${violation.hint}`);
    }
  }

  if (warnCount > 0) {
    lines.push("", `软警告 ${warnCount} 条（只记不拒）：`);
    for (const violation of result.warnings) {
      lines.push(`  [${violation.id}] ${violation.detail}`);
      lines.push(`      → ${violation.hint}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
