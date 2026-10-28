import { checkV30CrossFields, type MemoV30Violation } from "./cross-fields.js";
import { v30DocumentSchema, type V30Document } from "./schema.js";

/**
 * **v30 笔录 JSON 的校验入口**（产出侧）。
 *
 * 校验分两层：
 * 1. **结构**（`v30DocumentSchema`）—— 形状、必填、枚举、页码引用格式；
 * 2. **跨字段**（CF-01~08）—— 结构过不了就没有意义，结构过了才逐条求值。
 *
 * ⚠️ **软违（`hard: false`）只记不拒** —— 与宿主口径一致（CF-08）。
 */

/** 一次校验的完整结果。 */
export interface MemoV30ValidationResult {
  /** 没有硬违 → `true`（软违不算失败）。 */
  readonly ok: boolean;
  /** 结构合法时的文档（结构不合法时是 `undefined`）。 */
  readonly document?: V30Document;
  /** 结构问题（逐条 · 中文）。 */
  readonly structureIssues: readonly string[];
  /** 硬违（CF 里的 `hard: true`）。 */
  readonly violations: readonly MemoV30Violation[];
  /** 软违（CF 里的 `hard: false` · 只记不拒）。 */
  readonly warnings: readonly MemoV30Violation[];
}

/**
 * 校验一份 v30 笔录 JSON。
 *
 * @param raw 解析后的 JSON（**不**是 JSON 文本 —— 文本解析失败是调用方的事）。
 */
export function validateMemoV30(raw: unknown): MemoV30ValidationResult {
  const parsed = v30DocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      structureIssues: parsed.error.issues.map(formatIssue),
      violations: [],
      warnings: [],
    };
  }

  const all = checkV30CrossFields(parsed.data);
  const violations = all.filter((violation) => violation.hard);
  const warnings = all.filter((violation) => !violation.hard);
  return {
    ok: violations.length === 0,
    document: parsed.data,
    structureIssues: [],
    violations,
    warnings,
  };
}

/** zod 的一条 issue → 一行中文。 */
function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length === 0 ? "(根)" : issue.path.map(String).join(".");
  return `${path}：${issue.message}`;
}
