import { describe, expect, it } from "vitest";
import { validateMemoV30 } from "../src/memo-v30/index.js";
import type { V30Document } from "../src/memo-v30/index.js";

/**
 * v3.0 阅卷笔录契约的**产出侧**校验（spec: `docs/design/v2/memo-v30-contract.md`）。
 *
 * 每条跨字段约束（CF-01~08）**一正例一反例**；CF-08 是软违 → 走 warnings，不判失败。
 */

/** 一份三件材料的合法文档（覆盖 replica / digest / month_digest 三种输出模式）。 */
function baseDocument(): V30Document {
  return {
    case: { name: "赵阳阳职务侵占案", case_no: "高密检刑诉受〔2026〕370785000041号", volumes: 54 },
    volume: { no: "03", theme: "笔录类", page_total: 123 },
    catalog: [
      { kind: "item", seq: 1, title: "赵阳阳第1次讯问笔录", page_ref: "【卷03·第4-11页】" },
      { kind: "item", seq: 2, title: "搜查扣押清单", page_ref: "【卷03·第12页】" },
      { kind: "item", seq: 3, title: "2025年3月记账凭证", page_ref: "【卷03·第13页】" },
      { kind: "group", label: "2025年3月", page_ref: "【卷03·第13页】", seqs: [3] },
    ],
    evidence: [
      {
        seq: 1,
        type: "言词证据",
        output_mode: "replica",
        title: "赵阳阳第1次讯问笔录",
        page_ref: "【卷03·第4-11页】",
        page_numbers: [4, 5, 6, 7, 8, 9, 10, 11],
        meta: {
          time: "2025年10月29日09时55分至11时30分",
          place: "高密市公安局执法办案管理中心经济开发区分中心",
          interviewer: "文婷",
          interviewee: "赵阳阳",
          recorder: "张伟",
        },
        deleted: "权利义务告知书、个人基本信息（含身份证号）",
        body: [],
      },
      {
        seq: 2,
        type: "搜查扣押",
        output_mode: "digest",
        title: "搜查扣押清单",
        page_ref: "【卷03·第12页】",
        page_numbers: [12],
        meta: {
          agency: "高密市公安局",
          subject: "赵阳阳",
          place: "高密市",
          doc_no: "高公（扣）字〔2025〕370785号",
          date: "2025年10月29日",
        },
        body: [],
      },
      {
        seq: 3,
        type: "会计凭证",
        output_mode: "month_digest",
        title: "2025年3月记账凭证",
        page_ref: "【卷03·第13页】",
        page_numbers: [13],
        meta: {},
        group: { label: "2025年3月", page_ref: "【卷03·第13页】" },
        body: [],
      },
    ],
  };
}

/** 深拷贝（避免用例之间互相污染）。 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** 取某条 evidence（用例里改它）。 */
function evidenceOf(doc: V30Document, seq: number): V30Document["evidence"][number] {
  const found = doc.evidence.find((item) => item.seq === seq);
  if (found === undefined) throw new Error(`没有 seq ${seq} 的 evidence`);
  return found;
}

describe("v3.0 笔录契约 · 结构", () => {
  it("合法文档通过（无硬违、无结构问题）", () => {
    const result = validateMemoV30(baseDocument());
    expect(result.ok).toBe(true);
    expect(result.structureIssues).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("顶层多出字段直接拒（不静默丢字段）", () => {
    const doc = clone(baseDocument()) as Record<string, unknown>;
    doc["assembly"] = { run_id: "x" };
    const result = validateMemoV30(doc);
    expect(result.ok).toBe(false);
    expect(result.structureIssues.length).toBeGreaterThan(0);
  });

  it("页码引用格式不符 → 结构问题", () => {
    const doc = clone(baseDocument());
    evidenceOf(doc, 1).page_ref = "第4-11页";
    const result = validateMemoV30(doc);
    expect(result.ok).toBe(false);
    expect(result.structureIssues.join("\n")).toContain("page_ref");
  });

  it("disclosures 可选：没有这个字段照样过", () => {
    const doc = clone(baseDocument());
    expect(doc.disclosures).toBeUndefined();
    expect(validateMemoV30(doc).ok).toBe(true);
  });

  it("披露原因必须在闭集里", () => {
    const doc = clone(baseDocument());
    doc.disclosures = [{ seq: 1, reason: "随便编的理由" as never }];
    const result = validateMemoV30(doc);
    expect(result.ok).toBe(false);
    expect(result.structureIssues.join("\n")).toContain("reason");
  });

  it("题名未核验是逐件事实 → 必须带 seq", () => {
    const doc = clone(baseDocument());
    doc.disclosures = [{ reason: "catalog_title_unverified" }];
    const result = validateMemoV30(doc);
    expect(result.ok).toBe(false);
    expect(result.structureIssues.join("\n")).toContain("seq");
  });
});

describe("v3.0 笔录契约 · 跨字段约束 CF-01~08", () => {
  it("CF-01 输出模式必须等于按类型钉死的值", () => {
    const 正例 = validateMemoV30(baseDocument());
    expect(正例.violations.filter((v) => v.id === "CF-01")).toEqual([]);

    const doc = clone(baseDocument());
    evidenceOf(doc, 1).output_mode = "digest";
    const 反例 = validateMemoV30(doc);
    const hit = 反例.violations.find((v) => v.id === "CF-01");
    expect(hit).toBeDefined();
    expect(hit?.hard).toBe(true);
    expect(hit?.detail).toContain("replica");
  });

  it("CF-02 必填要素一个都不能少", () => {
    const 正例 = validateMemoV30(baseDocument());
    expect(正例.violations.filter((v) => v.id === "CF-02")).toEqual([]);

    const doc = clone(baseDocument());
    delete evidenceOf(doc, 1).meta["interviewer"];
    const 反例 = validateMemoV30(doc);
    const hit = 反例.violations.find((v) => v.id === "CF-02");
    expect(hit?.hard).toBe(true);
    expect(hit?.detail).toContain("interviewer");
  });

  it("CF-03 要素值不得只有空白字符", () => {
    const 正例 = validateMemoV30(baseDocument());
    expect(正例.violations.filter((v) => v.id === "CF-03")).toEqual([]);

    const doc = clone(baseDocument());
    evidenceOf(doc, 1).meta["interviewer"] = "   ";
    const 反例 = validateMemoV30(doc);
    const hit = 反例.violations.find((v) => v.id === "CF-03");
    expect(hit?.hard).toBe(true);
    expect(hit?.detail).toContain("interviewer");
  });

  it("CF-04 月份分组只允许出现在 month_digest 上", () => {
    const 正例 = validateMemoV30(baseDocument());
    expect(正例.violations.filter((v) => v.id === "CF-04")).toEqual([]);

    const doc = clone(baseDocument());
    evidenceOf(doc, 2).group = { label: "2025年3月", page_ref: "【卷03·第12页】" };
    const 反例 = validateMemoV30(doc);
    const hit = 反例.violations.find((v) => v.id === "CF-04");
    expect(hit?.hard).toBe(true);
    expect(hit?.detail).toContain("digest");
  });

  it("CF-05 deleted 只允许出现在言词证据上", () => {
    const 正例 = validateMemoV30(baseDocument());
    expect(正例.violations.filter((v) => v.id === "CF-05")).toEqual([]);

    const doc = clone(baseDocument());
    evidenceOf(doc, 2).deleted = "不该出现的删除项";
    const 反例 = validateMemoV30(doc);
    const hit = 反例.violations.find((v) => v.id === "CF-05");
    expect(hit?.hard).toBe(true);
    expect(hit?.detail).toContain("搜查扣押");
  });

  it("CF-06 目录 item 与正文逐条对应", () => {
    const 正例 = validateMemoV30(baseDocument());
    expect(正例.violations.filter((v) => v.id === "CF-06")).toEqual([]);

    const 少一条 = clone(baseDocument());
    少一条.catalog = 少一条.catalog.filter((entry) => entry.kind !== "item" || entry.seq !== 3);
    expect(validateMemoV30(少一条).violations.some((v) => v.id === "CF-06")).toBe(true);

    const 题名错位 = clone(baseDocument());
    const item = 题名错位.catalog.find(
      (entry): entry is Extract<typeof entry, { kind: "item" }> =>
        entry.kind === "item" && entry.seq === 2,
    );
    if (item === undefined) throw new Error("目录里没有 seq 2 的 item");
    item.title = "另一个题名";
    const 反例 = validateMemoV30(题名错位);
    const hit = 反例.violations.find((v) => v.id === "CF-06");
    expect(hit?.hard).toBe(true);
  });

  it("CF-07 月份组引用的 seq 必须真实存在", () => {
    const 正例 = validateMemoV30(baseDocument());
    expect(正例.violations.filter((v) => v.id === "CF-07")).toEqual([]);

    const doc = clone(baseDocument());
    const group = doc.catalog.find((entry) => entry.kind === "group");
    if (group?.kind !== "group") throw new Error("目录里没有 group");
    group.seqs = [99];
    const 反例 = validateMemoV30(doc);
    const hit = 反例.violations.find((v) => v.id === "CF-07");
    expect(hit?.hard).toBe(true);
    expect(hit?.detail).toContain("99");
  });

  it("CF-08 replica 带了正文 → 只记不拒（软违）", () => {
    const 正例 = validateMemoV30(baseDocument());
    expect(正例.warnings.filter((v) => v.id === "CF-08")).toEqual([]);

    const doc = clone(baseDocument());
    evidenceOf(doc, 1).body = [{ kind: "q", text: "问：有没有转移过款项？" }];
    const 反例 = validateMemoV30(doc);
    const hit = 反例.warnings.find((v) => v.id === "CF-08");
    expect(hit).toBeDefined();
    expect(hit?.hard).toBe(false);
    // 软违不判失败。
    expect(反例.ok).toBe(true);
    expect(反例.violations).toEqual([]);
  });
});

describe("v3.0 笔录契约 · 披露", () => {
  it("逐件披露与卷级披露都能带过去", () => {
    const doc = clone(baseDocument());
    doc.disclosures = [
      { seq: 1, reason: "catalog_title_unverified", note: "题名未能在正文起始页核验" },
      { reason: "catalog_unparsed", note: "目录表结构性不可信，整表作废" },
    ];
    const result = validateMemoV30(doc);
    expect(result.ok).toBe(true);
    expect(result.document?.disclosures).toHaveLength(2);
  });
});
