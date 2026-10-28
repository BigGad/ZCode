/**
 * v3.0 阅卷笔录契约（`apps/zcode-cli/docs/design/v2/v30-memo.schema.json`）的**产出侧**实现。
 *
 * ⚠️ **契约文件是唯一真身** —— 这里的表是编译期副本，漂移由
 * `packages/shared/test/memo-v30-contract-file.test.ts` 锁住。
 */

export * from "./tables.js";
export * from "./schema.js";
export * from "./cross-fields.js";
export * from "./validate.js";
