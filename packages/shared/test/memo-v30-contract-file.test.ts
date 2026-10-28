import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  V30_CROSS_FIELD_CHECKS,
  V30_DISCLOSURE_REASONS,
  V30_META_REQUIRED,
  V30_OUTPUT_MODE_BY_TYPE,
  V30_PAGE_REF_PATTERN,
} from "../src/memo-v30/index.js";

/**
 * **契约文件 ↔ TS 表的漂移锁**（spec: `docs/design/v2/memo-v30-contract.md` §2）。
 *
 * 契约文件（`v30-memo.schema.json`）是**唯一真身**；TS 表是它的编译期副本
 * （运行时读不到仓库里的 `docs/`）→ 漂了就红。
 */

/** 契约文件路径（从本测试文件所在目录起算）。 */
const CONTRACT_PATH = fileURLToPath(
  new URL("../../../apps/zcode-cli/docs/design/v2/v30-memo.schema.json", import.meta.url),
);

interface ContractFile {
  readonly properties: Record<string, unknown>;
  readonly "x-v30-output-mode-by-type": unknown;
  readonly "x-v30-meta-required": unknown;
  readonly "x-v30-disclosure-reasons": unknown;
  readonly "x-v30-cross-field-checks": unknown;
  readonly "x-v30-page-ref-pattern": unknown;
  readonly "x-v30-cross-field-constraints": readonly { id: string }[];
}

const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as ContractFile;

describe("v3.0 契约文件 ↔ TS 表（漂移锁）", () => {
  it("输出模式表逐字相等", () => {
    expect(contract["x-v30-output-mode-by-type"]).toEqual(V30_OUTPUT_MODE_BY_TYPE);
  });

  it("必填要素表逐字相等", () => {
    expect(contract["x-v30-meta-required"]).toEqual(V30_META_REQUIRED);
  });

  it("披露原因闭集逐字相等", () => {
    expect(contract["x-v30-disclosure-reasons"]).toEqual([...V30_DISCLOSURE_REASONS]);
  });

  it("跨字段约束的机器可读块逐字相等（id / kind / hard / 顺序都锁）", () => {
    expect(contract["x-v30-cross-field-checks"]).toEqual([...V30_CROSS_FIELD_CHECKS]);
  });

  it("页码引用格式逐字相等", () => {
    expect(contract["x-v30-page-ref-pattern"]).toBe(V30_PAGE_REF_PATTERN);
  });

  it("机器可读块覆盖 CF-01~08，且只有 CF-08 是软的", () => {
    const ids = V30_CROSS_FIELD_CHECKS.map((check) => check.id);
    expect(ids).toEqual(["CF-01", "CF-02", "CF-03", "CF-04", "CF-05", "CF-06", "CF-07", "CF-08"]);
    const soft = V30_CROSS_FIELD_CHECKS.filter((check) => !check.hard);
    expect(soft.map((check) => check.id)).toEqual(["CF-08"]);
  });

  it("机器可读块与散文块讲的是同一批约束", () => {
    const prose = contract["x-v30-cross-field-constraints"].map((entry) => entry.id);
    const machine = V30_CROSS_FIELD_CHECKS.map((check) => check.id);
    expect(machine).toEqual(prose);
  });

  it("顶层结构里有 disclosures（披露的唯一通道）", () => {
    expect(Object.keys(contract.properties)).toContain("disclosures");
  });
});
