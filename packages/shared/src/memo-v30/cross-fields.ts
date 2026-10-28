import type { V30Document, V30Evidence } from "./schema.js";
import {
  META_PLACEHOLDER,
  V30_CROSS_FIELD_CHECKS,
  V30_META_REQUIRED,
  V30_OUTPUT_MODE_BY_TYPE,
  type V30CheckKind,
} from "./tables.js";

/**
 * **跨字段约束（CF-01~08）的求值器**。
 *
 * ⚠️ **JSON Schema 表达不了跨字段规则** —— 契约文件自己写明「只照结构实现会被整卷拒」
 * → → 这里按 `kind` 逐条求值，`hard` 决定「硬违（拒收）」还是「只记不拒（警告）」。
 *
 * ⚠️ 求值方式与参数**全部来自 `V30_CROSS_FIELD_CHECKS`**（契约文件的机器可读块）
 * → 契约改了这里就跟着改（漂移由契约文件漂移锁测试守住）。
 */

/** 一条跨字段约束的违反。 */
export interface MemoV30Violation {
  /** CF 号（`CF-01` … `CF-08`）。 */
  readonly id: string;
  /** 求值方式（契约 `x-v30-cross-field-checks[].kind`）。 */
  readonly kind: V30CheckKind;
  /** `false` = 只记不拒（警告）；`true` = 硬违。 */
  readonly hard: boolean;
  /** 哪里错了（中文，可逐字断言）。 */
  readonly detail: string;
  /** 怎么改（可处置提示）。 */
  readonly hint: string;
  /** 相关的那一条 evidence 的 seq（文档级违规没有）。 */
  readonly seq?: number;
}

/** 一条约束的求值结果。 */
type CheckOutcome = {
  readonly detail: string;
  readonly hint: string;
  readonly seq?: number;
};

/** 逐条 evidence 求值的约束（三种）。 */
type PerEvidenceCheck = (evidence: V30Evidence) => CheckOutcome | undefined;

/** 整份文档求值的约束（两种）。 */
type PerDocumentCheck = (document: V30Document) => readonly CheckOutcome[];

/** 逐条求值的三种约束。 */
const PER_EVIDENCE_CHECKS: Readonly<Partial<Record<V30CheckKind, PerEvidenceCheck>>> = {
  output_mode_by_type: (evidence) => {
    const expect = V30_OUTPUT_MODE_BY_TYPE[evidence.type];
    if (evidence.output_mode === expect) return undefined;
    return {
      detail: `第 ${evidence.seq} 条（${evidence.type}）的 output_mode 应为 ${expect}，实际 ${evidence.output_mode}`,
      hint: `把 output_mode 改成 ${expect} —— v3.0 标准 §五 把每种材料的输出模式钉死，只有一种。`,
      seq: evidence.seq,
    };
  },

  required_meta: (evidence) => {
    const missing = V30_META_REQUIRED[evidence.type].filter((key) => !(key in evidence.meta));
    if (missing.length === 0) return undefined;
    return {
      detail: `第 ${evidence.seq} 条缺要素：${missing.join("、")}`,
      hint: `补上 ${missing.join("、")}；识别不出就填「${META_PLACEHOLDER}」—— 不得留空，也不得编造。`,
      seq: evidence.seq,
    };
  },

  no_empty_meta_value: (evidence) => {
    const empty = Object.entries(evidence.meta)
      .filter(([, value]) => value.trim() === "")
      .map(([key]) => key);
    if (empty.length === 0) return undefined;
    return {
      detail: `第 ${evidence.seq} 条的要素是空串：${empty.join("、")}`,
      hint: `空串 = 假装识别了却没内容 → 改成「${META_PLACEHOLDER}」或填上真实内容。`,
      seq: evidence.seq,
    };
  },

  group_only_when: (evidence) => {
    const allowed = V30_CROSS_FIELD_CHECKS.find((check) => check.kind === "group_only_when")?.when
      ?.output_mode;
    if (evidence.group === undefined) return undefined;
    if (evidence.output_mode === allowed) return undefined;
    return {
      detail: `第 ${evidence.seq} 条带了月份分组，但 output_mode 是 ${evidence.output_mode}`,
      hint: `月份分组只属于 ${allowed}（会计凭证的结构）→ 本条去掉 group 字段。`,
      seq: evidence.seq,
    };
  },

  field_only_when: (evidence) => {
    const check = V30_CROSS_FIELD_CHECKS.find((entry) => entry.kind === "field_only_when");
    const field = check?.field;
    const allowedType = check?.when?.type;
    if (field === undefined || allowedType === undefined) return undefined;
    const value = (evidence as Record<string, unknown>)[field];
    if (value === undefined) return undefined;
    if (evidence.type === allowedType) return undefined;
    return {
      detail: `第 ${evidence.seq} 条（${evidence.type}）不该带 ${field}`,
      hint: `${field} 只属于${allowedType}（标准 §七）→ 本条去掉 ${field} 字段。`,
      seq: evidence.seq,
    };
  },

  replica_body_empty: (evidence) => {
    if (evidence.output_mode !== "replica") return undefined;
    if (evidence.body.length === 0) return undefined;
    return {
      detail: `第 ${evidence.seq} 条是 replica 却带了正文（宿主未复刻，原样渲染）`,
      hint: `replica 的正文应由宿主用逐页转写原文 1:1 拼装 → 引擎侧 body 留空数组。`,
      seq: evidence.seq,
    };
  },
};

/** 整份文档求值的两种约束。 */
const PER_DOCUMENT_CHECKS: Readonly<Partial<Record<V30CheckKind, PerDocumentCheck>>> = {
  catalog_evidence_1to1: (document) => {
    const items = document.catalog.filter(
      (entry): entry is Extract<typeof entry, { kind: "item" }> => entry.kind === "item",
    );
    const outcomes: CheckOutcome[] = [];
    if (items.length !== document.evidence.length) {
      outcomes.push({
        detail: `目录条目数（${items.length}）与正文条数（${document.evidence.length}）不一致`,
        hint: `目录的 item 与 evidence 逐条对应 → 条数必须相等（不得漏、不得多）。`,
      });
      return outcomes;
    }
    items.forEach((item, index) => {
      const evidence = document.evidence[index];
      if (evidence === undefined) return;
      if (
        item.seq === evidence.seq &&
        item.title === evidence.title &&
        item.page_ref === evidence.page_ref
      ) {
        return;
      }
      outcomes.push({
        detail: `目录第 ${index + 1} 条与正文第 ${index + 1} 条不一致（seq / title / page_ref）`,
        hint: `目录第 ${index + 1} 条的 seq / title / page_ref 必须与正文第 ${index + 1} 条逐字相同。`,
      });
    });
    return outcomes;
  },

  group_seqs_exist: (document) => {
    const known = new Set(
      document.catalog
        .filter((entry): entry is Extract<typeof entry, { kind: "item" }> => entry.kind === "item")
        .map((item) => item.seq),
    );
    const outcomes: CheckOutcome[] = [];
    for (const group of document.catalog) {
      if (group.kind !== "group") continue;
      for (const seq of group.seqs) {
        if (known.has(seq)) continue;
        outcomes.push({
          detail: `月份组「${group.label}」引用了不存在的 seq ${seq}`,
          hint: `月份组引用的材料必须真实存在 → 修正 seqs，或把那一件补进目录。`,
        });
      }
    }
    return outcomes;
  },
};

/**
 * **逐条求值全部跨字段约束**。
 *
 * @param document 结构已通过校验的 v30 笔录 JSON。
 * @returns 违反列表（**含软违** —— 软违由调用方按 `hard` 分流）。
 */
export function checkV30CrossFields(document: V30Document): readonly MemoV30Violation[] {
  const violations: MemoV30Violation[] = [];
  for (const check of V30_CROSS_FIELD_CHECKS) {
    const perEvidence = PER_EVIDENCE_CHECKS[check.kind];
    if (perEvidence !== undefined) {
      for (const evidence of document.evidence) {
        const outcome = perEvidence(evidence);
        if (outcome === undefined) continue;
        violations.push(toViolation(check.id, check.kind, check.hard, outcome));
      }
      continue;
    }
    const perDocument = PER_DOCUMENT_CHECKS[check.kind];
    if (perDocument === undefined) continue;
    for (const outcome of perDocument(document)) {
      violations.push(toViolation(check.id, check.kind, check.hard, outcome));
    }
  }
  return violations;
}

function toViolation(
  id: string,
  kind: V30CheckKind,
  hard: boolean,
  outcome: CheckOutcome,
): MemoV30Violation {
  return {
    id,
    kind,
    hard,
    detail: outcome.detail,
    hint: outcome.hint,
    ...(outcome.seq === undefined ? {} : { seq: outcome.seq }),
  };
}
