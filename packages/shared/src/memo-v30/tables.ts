/**
 * v3.0 阅卷笔录契约的**表**（`v30-memo.schema.json` 里 `x-v30-*` 块的编译期副本）。
 *
 * ⚠️ **唯一真身是契约文件**（`apps/zcode-cli/docs/design/v2/v30-memo.schema.json`）。
 * 这里的表是**编译期副本** —— 运行时**不读文件**（CLI 是 npm 装的，读不到仓库里的 docs）。
 * 漂移由 `packages/shared/test/memo-v30-contract-file.test.ts` 锁住：
 * 契约文件里任何一张表改了而这里没跟上 → 那条测试红。
 */

/** v30 的九类材料（⚠️ 比宿主的内部八类多一类：鉴定意见 / 审计报告分开）。 */
export const V30_TYPES = [
  "言词证据",
  "鉴定意见",
  "审计报告",
  "搜查扣押",
  "书证",
  "勘验检查",
  "电子数据",
  "银行流水",
  "会计凭证",
] as const;

/** v30 九类之一。 */
export type V30Type = (typeof V30_TYPES)[number];

/** 产出方式（四个）。 */
export const V30_OUTPUT_MODES = ["replica", "digest", "digest_excel", "month_digest"] as const;

/** 产出方式之一。 */
export type V30OutputMode = (typeof V30_OUTPUT_MODES)[number];

/** **每种材料的输出模式钉死**（契约 `x-v30-output-mode-by-type` · CF-01 的依据）。 */
export const V30_OUTPUT_MODE_BY_TYPE: Readonly<Record<V30Type, V30OutputMode>> = {
  言词证据: "replica",
  鉴定意见: "replica",
  审计报告: "replica",
  搜查扣押: "digest",
  书证: "digest",
  勘验检查: "digest",
  电子数据: "digest",
  银行流水: "digest_excel",
  会计凭证: "month_digest",
};

/** **每类必填的要素键**（契约 `x-v30-meta-required` · CF-02 的依据）。 */
export const V30_META_REQUIRED: Readonly<Record<V30Type, readonly string[]>> = {
  言词证据: ["time", "place", "interviewer", "interviewee", "recorder"],
  搜查扣押: ["agency", "subject", "place", "doc_no", "date"],
  书证: ["unit", "cause", "legal_basis", "approval", "filed_at"],
  勘验检查: ["time", "place", "personnel", "findings"],
  鉴定意见: [],
  审计报告: [],
  会计凭证: [],
  电子数据: [],
  银行流水: [],
};

/** **要素键的中文标签**（表里没有的键 → 原样保留，不猜不丢）。 */
export const META_LABEL_ZH: Readonly<Record<string, string>> = {
  time: "时间",
  place: "地点",
  interviewer: "讯问人",
  interviewee: "被讯问人",
  recorder: "记录人",
  agency: "办案机构",
  subject: "扣押对象",
  doc_no: "文书编号",
  date: "日期",
  unit: "制作单位",
  cause: "事由",
  legal_basis: "法律依据",
  approval: "批准机关",
  filed_at: "提交时间",
  personnel: "勘验人员",
  findings: "勘验情况",
};

/** 要素识别不出时的占位（不得留空 —— CF-03）。 */
export const META_PLACEHOLDER = "（OCR未识别）";

/**
 * **披露原因的闭集**（契约 `x-v30-disclosure-reasons`）。
 *
 * ⚠️ 与宿主的降级原因闭集**同集** → 宿主可 1:1 回填，不做二次映射。
 */
export const V30_DISCLOSURE_REASONS = [
  "model_unavailable",
  "model_invalid",
  "reask_exhausted",
  "citation_missing",
  "number_gate_failed",
  "wordlist_hit",
  "catalog_unparsed",
  "catalog_empty",
  "catalog_title_unverified",
  "boundary_missing",
] as const;

/** 披露原因之一。 */
export type V30DisclosureReason = (typeof V30_DISCLOSURE_REASONS)[number];

/**
 * **逐件才成立的披露原因**（必须带 `seq`）。
 *
 * 「题名未核验」是**每一件**的事实 → 宿主要标出**是哪一件**没核验 → 少了 `seq` 就无从标注。
 */
export const V30_PER_ITEM_DISCLOSURE_REASONS = ["catalog_title_unverified"] as const;

/** 跨字段约束的求值方式（契约 `x-v30-cross-field-checks[].kind`）。 */
export const V30_CHECK_KINDS = [
  "output_mode_by_type",
  "required_meta",
  "no_empty_meta_value",
  "group_only_when",
  "field_only_when",
  "catalog_evidence_1to1",
  "group_seqs_exist",
  "replica_body_empty",
] as const;

/** 求值方式之一。 */
export type V30CheckKind = (typeof V30_CHECK_KINDS)[number];

/** 一条跨字段约束的机器可读描述。 */
export interface V30CrossFieldCheck {
  readonly id: string;
  readonly kind: V30CheckKind;
  /** `false` = 只记不拒（警告）；`true` = 硬违（整条/整份拒收）。 */
  readonly hard: boolean;
  /** `group_only_when` / `field_only_when` 的生效条件。 */
  readonly when?: Readonly<Record<string, string>>;
  /** `field_only_when` 管的字段名。 */
  readonly field?: string;
}

/**
 * **CF-01~08 的机器可读形式**（契约 `x-v30-cross-field-checks`）。
 *
 * ⚠️ `hard: false` 的那条（CF-08「replica 的正文应由宿主复刻」）是**只记不拒**：
 * 来源真的给了正文时，拒收等于把律师的卷宗变成空白 → 照渲染 + 记一条降级披露。
 */
export const V30_CROSS_FIELD_CHECKS: readonly V30CrossFieldCheck[] = [
  { id: "CF-01", kind: "output_mode_by_type", hard: true },
  { id: "CF-02", kind: "required_meta", hard: true },
  { id: "CF-03", kind: "no_empty_meta_value", hard: true },
  { id: "CF-04", kind: "group_only_when", when: { output_mode: "month_digest" }, hard: true },
  {
    id: "CF-05",
    kind: "field_only_when",
    field: "deleted",
    when: { type: "言词证据" },
    hard: true,
  },
  { id: "CF-06", kind: "catalog_evidence_1to1", hard: true },
  { id: "CF-07", kind: "group_seqs_exist", hard: true },
  { id: "CF-08", kind: "replica_body_empty", hard: false },
];

/** 契约里的页码引用格式（`x-v30-page-ref-pattern`）。 */
export const V30_PAGE_REF_PATTERN = "^【卷\\d{2}·第\\d+(-\\d+)?页(起)?】$";

/** 页码引用的编译期正则（与 `V30_PAGE_REF_PATTERN` 同源）。 */
export const V30_PAGE_REF_RE = /^【卷\d{2}·第\d+(-\d+)?页(起)?】$/;
