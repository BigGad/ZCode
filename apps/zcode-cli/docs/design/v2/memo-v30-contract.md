# v3.0 阅卷笔录契约 —— 可执行化

## 1. Purpose & Scope

v3.0 阅卷笔录的 JSON 数据源由 `v30-memo.schema.json`（本目录下）定义。**Word 只是这份 JSON 的渲染结果** —— 同一份 JSON 渲染出的 Word 必须完全一致。

本 spec 讲三件事：

1. **契约文件是唯一真身**，代码里的表是它的编译期副本；
2. **跨字段约束（CF-01~08）怎么被执行**（结构合同表达不了跨字段规则）；
3. **产出侧怎么自检** —— `zcode memo validate <file.json>`。

**适用场景**

- 产出侧（人或 agent）写完 `memo_v30.json` → 立刻自检，不靠人肉核对；
- 宿主侧（律小虾 CLI）把同一份契约作为**摄入**合同 → 结构 + CF 双重拦截。

**不在本轮范围**

- **不做**内部 `memo.json` → v30 的转换器（宿主内部形状仍是自己的，v30 只是摄入入口）；
- **不做**摘要型结构（要素标签 + 页码 + 逐字引用）在 v30 `body` 里的表达 —— 那是契约的下一版；
- **不做**宿主内部形状退役成 v30 原生。

---

## 2. 唯一真身与两份实现

| 位置                                            | 是什么                                     | 性质                     |
| ----------------------------------------------- | ------------------------------------------ | ------------------------ |
| `docs/design/v2/v30-memo.schema.json`          | **契约本体**（结构 + CF 散文 + 机器可读块） | 唯一真身                 |
| `packages/shared/src/memo-v30/*`                | ZCode 侧（**产出侧**）校验                 | 契约文件的编译期副本     |
| 律小虾 `packages/cli/src/memo/v30.ts`          | 宿主侧（**消费侧**）摄入 + 强制            | 契约文件的另一份实现     |

**为什么运行时不读契约文件**：CLI 是 npm 安装的，运行时读不到仓库里的 `docs/`。所以表必须编译进代码。

**怎么防漂**：契约文件里的四块（`x-v30-output-mode-by-type` / `x-v30-meta-required` / `x-v30-disclosure-reasons` / `x-v30-cross-field-checks`）与 TS 表**逐字相等**这条断言，锁在 `packages/shared/test/memo-v30-contract-file.test.ts`。契约文件改了而 TS 没跟上 → 那条测试红。

> ⚠️ 宿主侧（律小虾仓）的那份 zod 镜像**没有**同仓的漂移锁 —— 它靠「两边都照契约文件手写 + 契约文件本身带散文说明」维持。本轮不跨仓加锁（跨仓的测试基建不在本轮范围）。

---

## 3. 结构合同

`packages/shared/src/memo-v30/schema.ts` 是契约文件结构部分的 zod 镜像：

- `case` / `volume` / `catalog[]` / `evidence[]` —— 四件套，**必填**；
- `disclosures[]` —— **可选**（见 §5）。旧文件没有这个字段照样过；
- 一切对象 `.strict()` —— 多出来的字段直接拒（不静默丢字段）。

**页码引用**：`^【卷\d{2}·第\d+(-\d+)?页(起)?】$`。

---

## 4. 跨字段约束（CF-01~08）

**JSON Schema 表达不了跨字段规则** —— 契约文件自己写明「只照结构实现会被整卷拒」。

契约文件里 CF 有两份表示：

| 块                                | 面向谁     | 形态                             |
| --------------------------------- | ---------- | -------------------------------- |
| `x-v30-cross-field-constraints`   | 人         | 散文（`rule` / `why` / `error`） |
| `x-v30-cross-field-checks`       | 机器       | `{id, kind, hard, …}`           |

`kind` 是求值方式，校验器按 `kind` 分派；`hard` 决定「硬违（拒收）」还是「只记不拒（警告）」。

| CF    | kind                   | hard | 说什么                                                    |
| ----- | ---------------------- | ---- | --------------------------------------------------------- |
| CF-01 | `output_mode_by_type`  | true | `output_mode` 必须等于按类型钉死的值                      |
| CF-02 | `required_meta`        | true | 必填要素键一个都不能少                                     |
| CF-03 | `no_empty_meta_value`  | true | 要素值不得是空串（识别不出填「（OCR未识别）」）            |
| CF-04 | `group_only_when`      | true | `group` 只允许出现在 `month_digest` 上                    |
| CF-05 | `field_only_when`      | true | `deleted` 只允许出现在 `言词证据` 上                      |
| CF-06 | `catalog_evidence_1to1` | true | 目录 item 与正文逐条对应（条数相等 + seq/title/page_ref 相同）|
| CF-07 | `group_seqs_exist`     | true | 月份组引用的 seq 必须真实存在                              |
| CF-08 | `replica_body_empty`   | **false** | `replica` 的 `body` 应为空（正文由宿主用转写原文拼装）   |

**CF-08 为什么是软的**：来源真的给了正文时，拒收等于把律师的卷宗变成空白 → 照渲染 + 记一条降级披露。其余七条一律硬拒。

---

## 5. `disclosures` —— 披露的唯一通道

**问题**：v30 原本没有地方放「19 件题名未核验」「摘要不过闸」这类降级事实 → 产出的 v30 文件在宿主侧渲染时**丢掉披露**（撞「如实披露」红线）。

**形状**：

```jsonc
"disclosures": [
  { "seq": 3, "reason": "catalog_title_unverified", "note": "题名未能在正文起始页核验" },
  { "reason": "catalog_unparsed", "note": "目录表结构性不可信，整表作废" }
]
```

| 字段     | 必填 | 说明                                                          |
| -------- | ---- | ------------------------------------------------------------- |
| `seq`    | 视情况 | 逐件披露时指向那一条 `evidence` 的 `seq`；**省略 = 卷级披露** |
| `reason` | 是   | 闭集 `x-v30-disclosure-reasons`（10 个）                       |
| `note`   | 否   | 人读的中文说明                                                |

**约束**：`reason === "catalog_title_unverified"` **必须**带 `seq` —— 题名未核验是**逐件**事实，少了 `seq` 宿主无从标出**是哪一件**没核验。

**`reason` 闭集与宿主同集** → 宿主可 1:1 回填，不做二次映射。

**宿主怎么用**：逐件披露回填进 `assembly.degraded`（→ Word 顶部披露行的「K 件降级」+ 目录末尾的「题名未核验」行）；卷级披露落在 `assembly.rules_applied`（JSON 内可见，Word 上不单独成行 —— **已知边界**）。

---

## 6. `zcode memo validate`

```
zcode memo validate <file.json> [--json]
```

**无新 flag**：文件是位置参数，`--json` 是全局的 → `arguments.ts` 不用改。

| 退出码 | 含义                                                |
| ------ | --------------------------------------------------- |
| `0`    | 通过（**含软违**：CF-08 只记不拒）                  |
| `1`    | 有硬违，或结构不合法                                |
| `2`    | 文件读不到 / 不是合法 JSON                         |

**输出**：文本模式逐条给「CF 号 + 哪里错了 + 怎么改」；`--json` 给 `{file, ok, structureIssues, violations, warnings}`。

**为什么需要它**：以前 CF 只在宿主侧（导出 Word 时）才拦 → 产出侧写完只能人肉核对。skill 的验收清单里 16 条没有一条能自动跑。

---

## 7. 代码地图

| 文件                                                        | 作用                                   |
| ----------------------------------------------------------- | -------------------------------------- |
| `docs/design/v2/v30-memo.schema.json`                        | 契约本体（唯一真身）                   |
| `docs/design/v2/memo-v30-contract.md`                        | 本 spec                                |
| `packages/shared/src/memo-v30/tables.ts`                     | 契约表的编译期副本                     |
| `packages/shared/src/memo-v30/schema.ts`                     | 结构合同（zod）                        |
| `packages/shared/src/memo-v30/cross-fields.ts`               | CF 求值器                              |
| `packages/shared/src/memo-v30/validate.ts`                   | 校验入口                              |
| `packages/shared/test/memo-v30.test.ts`                      | 结构 + CF 正反例                      |
| `packages/shared/test/memo-v30-contract-file.test.ts`        | **漂移锁**（契约文件 ↔ TS 表）        |
| `apps/zcode-cli/packages/cli/src/memo-command.ts`            | `zcode memo validate`                  |
| `apps/zcode-cli/packages/cli/tests/memo-command.test.ts`     | 退出码 + 输出形状                      |
| 律小虾 `packages/cli/src/memo/v30.ts`                        | 宿主侧摄入镜像（另一份实现）           |
