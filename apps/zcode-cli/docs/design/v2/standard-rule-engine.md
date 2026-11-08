# 统一规范与规则引擎（规范一套）

## 1. 目的与范围

把「专业规范 / 标准」这件事从**每个规范写一套 schema + 一套校验代码**，改成**一套骨架 + 一份标准档案（profile）+ 一台通用规则引擎**。

**决策（用户已定）**：**规范一套**。

**现状（已验证）**：仓库里已有一套可用的声明式规则引擎，绑死在 v3.0 阅卷笔录上：

- `packages/shared/src/memo-v30/`：`tables.ts`（表）+ `schema.ts`（zod 结构）+ `cross-fields.ts`（跨字段求值）+ `validate.ts`（入口）。
- 契约文件 `apps/zcode-cli/docs/design/v2/v30-memo.schema.json` 是**唯一真身**；`tables.ts` 是**编译期副本**；漂移由 `packages/shared/test/memo-v30-contract-file.test.ts` 锁住。⚠️ **但这个漂移锁当前根本没跑**（`packages/shared` 没有 test 入口，根门禁清单里 0 条）—— 见 §9.2，本 spec 的第 0 步就是修它。
- 跨字段约束用 `kind` 分派到两种求值器：`PER_EVIDENCE_CHECKS`（逐条）与 `PER_DOCUMENT_CHECKS`（整份）；`hard: true` = 硬违（拒收），`hard: false` = 只记不拒（软违）。
- 产出侧 CLI 已存在：`zcode memo validate <file.json>`（`apps/zcode-cli/packages/cli/src/memo-command.ts`，退出码 `0` 通过 / `1` 硬违 / `2` 读不到或非法 JSON）。

**本 spec 定义**：通用骨架 schema、标准档案（profile）契约、通用规则引擎、条文引用、交付契约、以及 `zcode standards` 命令面。

**不适用**

- 不改 memo-v30 的**契约内容**（九类材料、CF-01~08 的语义一字不动）—— 只是把它变成「一份 profile」。
- 不做条文库的全文检索（那是 RAG 的事，见 [`knowledge-rag.md`](./knowledge-rag.md)）。
- 不做运行时自动修（只报错，不改用户的产出物）。

**与能力注册表的关系（先说清楚，免得两边打架）**

[`capability-registry.md`](./capability-registry.md) 定义的「能力」= **一次实现、三处投影**（CLI / MCP / 内置工具）的那类东西。**本 spec 的规则引擎不注册成能力键** —— 它已经有自己的命令面 `zcode standards validate`（§7），退出码 `0/1/2` 是既有对外契约，而 `CapabilityErrorCode` 是另一套闭集（两套不兼容，见 §7.1）。

→ 结论：本 spec **不进** `capability-registry.md` 的实施序列。将来若要改成能力键，三件事必须**同时**做（§7.1 + `capability-registry.md` §11 未决问题 7）。

⚠️ 反过来也成立：**`capability-registry.md` 的 §7 把 `zcode standards validate` 列为退出码 `0/1/2` 的明确例外** —— 两边口径一致，不是两份各自为政的说法。

## 2. 规范的五层模板

「规范一套」落地成五层。**每层都可独立替换**，但层间顺序固定：

| 层 | 内容 | 载体 | 谁执行 |
| --- | --- | --- | --- |
| **L1 结构约束** | 形状、必填、枚举、格式 | JSON Schema（zod 镜像） | 引擎第一步 |
| **L2 跨字段约束** | JSON Schema 表达不了的规则 | 声明式 check 列表（`kind` 分派） | 引擎第二步 |
| **L3 条文判例** | 每条规则的**依据**（法条 / 规范条文 / 内部标准条款） | profile 的 `basis` 映射 | 引擎附在违规上 |
| **L4 执行编排** | 谁来跑、按什么顺序、跑哪几步 | workflow / skill 定义 | 编排器（dwf / expert / 普通 prompt） |
| **L5 产出自检** | 写完就验，不等宿主 | validator CLI | `zcode standards validate` |

**关键设计**：L1/L2/L3/L5 是**同一台引擎**的四个面，L4 是外部编排。引擎不认识「阅卷笔录」也不认识「质检报告」—— 它只认识「档案（profile）」。

## 3. 通用骨架

所有标准共用一份 JSON 形状；差异全部下沉到 profile。

```jsonc
{
  "standard": "memo-v30",          // 标准 id（= profile id）
  "version": "3.0",                // 标准版本
  "context": {                     // 上下文（案件 / 项目 / 工单 …）
    "case": { "name": "…", "case_no": "…", "volumes": 12 },
    "volume": { "no": "03", "theme": "…", "page_total": 128 }
  },
  "catalog": [                     // 目录
    { "kind": "item",  "seq": 1, "title": "…", "locator": "【卷03·第4-11页】" },
    { "kind": "group", "label": "2024年3月", "locator": "…", "seqs": [3, 4] }
  ],
  "items": [                       // 正文条目
    {
      "seq": 1,
      "type": "言词证据",            // ← 标准自定义的条目类型枚举
      "output_mode": "replica",      // ← 标准自定义的产出方式枚举
      "title": "…",
      "locator": "【卷03·第4-11页】", // ← 标准自定义的引用格式
      "locators": [4, 5, 6],         // 引用到的页号（可选）
      "meta": { "time": "…" },       // ← 标准自定义的要素键
      "body": [ { "kind": "q", "text": "…" } ],
      "group": { "label": "…", "locator": "…" }
    }
  ],
  "disclosures": [                 // 披露（降级 / 未核验的事实）
    { "reason": "catalog_title_unverified", "seq": 7, "note": "…" }
  ]
}
```

**骨架与 memo-v30 的对应关系**（memo-v30 迁移后）：

| 骨架字段 | memo-v30 现状 |
| --- | --- |
| `context.case` / `context.volume` | `case` / `volume`（顶层） |
| `items[]` | `evidence[]` |
| `items[].locator` | `evidence[].page_ref` |
| `items[].locators` | `evidence[].page_numbers` |
| `catalog[].locator` | `catalog[].page_ref` |

⚠️ **字段改名会影响已有产出物**。memo-v30 的 JSON 是对外交付格式，改名是破坏性变更 → **迁移必须双读**（引擎同时接受 `evidence`/`items`、`page_ref`/`locator`），并在契约文件里把旧名标为 deprecated。见 §9。

## 4. 标准档案（Profile）

```ts
// packages/shared/src/standards/contract.ts
/** 一份标准档案。数据，不是代码。 */
export interface StandardProfile {
  /** 标准 id（如 "memo-v30"）。 */
  readonly id: string;
  /** 标准版本（字符串，允许 "3.0" 这种非 semver）。 */
  readonly version: string;
  readonly title: string;

  /** 条目类型闭集（如 v30 的九类材料）。 */
  readonly itemTypes: readonly string[];
  /** 产出方式闭集（如 replica / digest / digest_excel / month_digest）。 */
  readonly outputModes: readonly string[];
  /** 每种条目类型钉死的产出方式。 */
  readonly outputModeByType: Readonly<Record<string, string>>;
  /** 每种条目类型必填的要素键。 */
  readonly requiredMeta: Readonly<Record<string, readonly string[]>>;
  /** 要素键的中文标签（表里没有的键原样保留，不猜不丢）。 */
  readonly metaLabels: Readonly<Record<string, string>>;
  /** 识别不出时的占位（如 "（OCR未识别）"）。 */
  readonly metaPlaceholder: string;
  /** 引用格式的正则（完整匹配）。 */
  readonly locatorPattern: string;
  /** 披露原因的闭集。 */
  readonly disclosureReasons: readonly string[];
  /** 必须逐件才成立的披露原因（必须带 seq）。 */
  readonly perItemDisclosureReasons: readonly string[];
  /** 跨字段约束（声明式）。 */
  readonly crossFieldChecks: readonly CrossFieldCheck[];
  /** L3 条文依据：check id → 依据引用。 */
  readonly basis: Readonly<Record<string, string>>;
  /** L1 结构约束（zod schema 或等价 JSON Schema）。 */
  readonly structure: StandardStructure;
  /** 交付契约：产出方式 → 交付物形态。 */
  readonly delivery: Readonly<Record<string, DeliverySpec>>;
}

/** 一条跨字段约束的机器可读描述（沿用 memo-v30 的形状）。 */
export interface CrossFieldCheck {
  readonly id: string;
  /** 求值方式（见下表）。 */
  readonly kind: CrossFieldCheckKind;
  /** false = 只记不拒（警告）；true = 硬违（拒收）。 */
  readonly hard: boolean;
  /** 生效条件（如 group_only_when 的 when.output_mode）。 */
  readonly when?: Readonly<Record<string, string>>;
  /** field_only_when 管的字段名。 */
  readonly field?: string;
}

export type CrossFieldCheckKind =
  | "output_mode_by_type"
  | "required_meta"
  | "no_empty_meta_value"
  | "group_only_when"
  | "field_only_when"
  | "catalog_items_1to1"
  | "group_seqs_exist"
  | "replica_body_empty";
```

⚠️ **上面三个被引用但没定义的类型**，在此写死（否则实现时各写各的，profile 契约就散了）：

```ts
// packages/shared/src/standards/contract.ts
import type { z } from "zod";

/** L1 结构约束：zod schema **或** JSON Schema 对象（§14 未决问题 4：两者都支持，引擎择一）。 */
export type StandardStructure =
  | z.ZodType<unknown>
  | { readonly $schema?: string; readonly [key: string]: unknown };

/** 规范化后的骨架文档（§3 的形状）。引擎内部只见这个形态。 */
export interface StandardDocument {
  readonly standard: string;
  readonly version: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly catalog: readonly Readonly<Record<string, unknown>>[];
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly disclosures: readonly Readonly<Record<string, unknown>>[];
}

/** 一个产出方式的交付物形态（L5 产出侧）。 */
export interface DeliverySpec {
  /** 交付物类型（如 "json" / "docx" / "xlsx" / "none"）。 */
  readonly kind: string;
  /** 该产出方式是否需要走 L4 编排才能产出（"replica" 需要，宿主复刻）。 */
  readonly needsOrchestration: boolean;
  /** 附加说明（给 `zcode standards describe` 打印）。 */
  readonly note?: string;
}
```

⚠️ `StandardDocument` 里四个字段用 `unknown` 值类型，是**故意的**：条目类型 / 产出方式 / 要素键都是**标准自定义**的闭集（`profile.itemTypes` / `profile.outputModes` / `profile.requiredMeta`），引擎**不认识**它们的具体取值 —— 一旦这里写成具体联合类型，就等于把 memo-v30 的九类材料焊进通用引擎（那正是本 spec 要消灭的）。**具体闭集在 profile 里，引擎只按 profile 校验。**

⚠️ `catalog_evidence_1to1` 在通用骨架里改名为 `catalog_items_1to1`（骨架叫 items）。**profile 里保留别名表**，让 memo-v30 的契约文件不必改 check id（id 是对外可见的编号，改了要动交付物与披露记录）。

### 4.1 求值方式（通用 kind 集）

沿用 memo-v30 已有的 8 种，**语义与命名不再增加**：

| kind | 作用域 | 依据 |
| --- | --- | --- |
| `output_mode_by_type` | 逐条 | `outputModeByType[type]` 必须等于该条的 `output_mode` |
| `required_meta` | 逐条 | `requiredMeta[type]` 的每个键都必须在 `meta` 里 |
| `no_empty_meta_value` | 逐条 | `meta` 的值不得是空串 |
| `group_only_when` | 逐条 | 带了 `group` 就必须满足 `when` |
| `field_only_when` | 逐条 | 某字段只在 `when.type` 下允许出现 |
| `catalog_items_1to1` | 整份 | 目录 item 与正文条目**逐条对应**（seq / title / locator 逐字相同） |
| `group_seqs_exist` | 整份 | 目录 group 引用的 seq 必须真实存在 |
| `replica_body_empty` | 逐条 | `replica` 产出方式的正文由宿主复刻，引擎侧留空 |

**加 kind 的门槛**：新增一种求值方式 = 新增一段通用求值代码 → 必须同时给出**至少两个**标准的使用场景，否则说明是某个标准的私货。

⚠️ **私货不许走「profile 扩展」后门**。「某个标准自己写一段扩展求值代码」是**明确禁止**的 —— 那等于回到「每个规范写一套校验代码」的起点，**「规范一套」就废了**。一个标准特有的规则只有三个去处：

| 去处 | 适用 | 代价 |
| --- | --- | --- |
| **profile 的数据表**（`outputModeByType` / `requiredMeta` / `metaLabels` / `basis` / `structure`） | 规则能表达成「某类型 → 某产出方式」「某类型必填某键」这类查表 | 零代码 |
| **L1 结构约束**（profile 的 `structure` schema） | 形状、必填、枚举、格式 | 零代码 |
| **L3 条文依据**（`basis` / `hint`） | 规则是「提示性」而非可判定的（如「应当核实送达方式」） | 零代码，只能提示、不能拒收 |

**只有「可判定但表表达不了」的情况才允许加 kind**，且必须带第二个标准的使用场景。若一个标准既有表表达不了的、又不是提示性的规则 → 说明通用 kind 集缺了一种表达能力，**加 kind 是正解**，不是绕过。

⚠️ 同理：**引擎里不许出现 `if (standard === "xxx")`**，profile 的数据驱动是硬约束（§10 反模式）。

## 5. 通用规则引擎

### 5.1 入口

```ts
// packages/shared/src/standards/engine/validate.ts
export interface StandardValidationResult {
  readonly ok: boolean;                       // 无硬违 → true（软违不算失败）
  readonly document?: StandardDocument;       // 结构合法时的文档
  readonly structureIssues: readonly string[]; // 逐条中文
  readonly violations: readonly RuleViolation[];  // 硬违
  readonly warnings: readonly RuleViolation[];    // 软违
  readonly standard: { readonly id: string; readonly version: string };
}

export interface RuleViolation {
  readonly id: string;         // check id（如 CF-01）
  readonly kind: CrossFieldCheckKind;
  readonly hard: boolean;
  readonly detail: string;     // 中文，可逐字断言
  readonly hint: string;       // 怎么改
  readonly basis?: string;     // L3 依据（法条 / 条款引用）
  readonly seq?: number;       // 相关条目的 seq（整份级违规没有）
}

export function validateStandard(raw: unknown, profile: StandardProfile): StandardValidationResult;
```

**两层求值，顺序固定**（与 memo-v30 现状一致）：

1. **结构**（L1）：profile 的结构 schema 校验。结构不合法 → 直接返回，**不做跨字段求值**（结构过了才有意义）。
2. **跨字段**（L2 + L3）：逐条 check 求值；`hard` 分流成 violations / warnings；`profile.basis[check.id]` 附到违规上。

### 5.2 通用化改造点（memo-v30 → 引擎）

现状 `checkV30CrossFields(document)` **直接 import 模块级常量**（`V30_OUTPUT_MODE_BY_TYPE` / `V30_META_REQUIRED` / `V30_CROSS_FIELD_CHECKS`）。通用化后：

```ts
// 改前
export function checkV30CrossFields(document: V30Document): readonly MemoV30Violation[]

// 改后
export function checkCrossFields(
  document: StandardDocument,
  profile: StandardProfile,
): readonly RuleViolation[]
```

每个 kind 的求值器从 `profile` 取表，**不再 import 常量**。

⚠️ **memo-v30 的行为必须不变**：改造后 `packages/shared/test/memo-v30.test.ts` 的**全部既有断言必须照过**（现有断言用 `toContain` 命中 detail 里的关键片段，如 `"replica"` / `"interviewer"` / `"搜查扣押"` / `"99"`；`hint` 目前无断言）。这是重构的验收线。

### 5.3 骨架的兼容读取

引擎读到的文档要**同时接受骨架名与 memo-v30 旧名**：

| 骨架 | memo-v30 旧名 |
| --- | --- |
| `items` | `evidence` |
| `locator` | `page_ref` |
| `context` | `case` + `volume`（顶层） |

规范化在引擎入口做一次（`normalizeDocument`），之后所有求值器只见**规范化后的骨架**。

## 6. L3 条文判例

每条 check 挂**依据**：`profile.basis[check.id] = "《刑事诉讼法》第 50 条"`。

- 依据是**纯引用**（不是可执行代码），引擎只负责附在违规输出里。
- 判例 / 内部标准条款同理：写进 `basis` 或 `hint`。
- **条文库里若有需要检索的条文**（如「找所有涉及某法条的证据」）→ 走 RAG（`knowledge-rag.md`），规则引擎**不**做全文检索。

`RuleViolation.basis` 是**新增字段**（memo-v30 的 `MemoV30Violation` 没有）。这是**加字段不是改字段** → 对既有消费方（`memo-command.ts` 的 JSON 输出）**向后兼容**：老字段不动，新字段可选。

## 7. L5 产出自检（命令面）

```
zcode standards list
zcode standards describe <standard>
zcode standards validate <file.json> [--standard <id>]
```

- `list`：列出已装的标准（id / 标题 / 版本）。
- `describe`：打印该标准的档案摘要（条目类型、产出方式、check 列表）。
- `validate`：校验一份产出物。

⚠️⚠️ **`--standard` 必须在全局 `arguments.ts` 里注册，否则命令一出生就是死的**。

CLI 是**单一全局严格解析**：`apps/zcode-cli/packages/cli/src/arguments.ts:177` 的 `parseArgs({ strict: true, allowPositionals: true })` —— **未知旗标直接抛错**，不存在「子命令自己解析自己旗标」这回事。实测：

```js
parseArgs({ args: ["standards", "validate", "a.json", "--standard", "memo-v30"], options: {}, allowPositionals: true, strict: true })
// → throw: Unknown option '--standard'.
```

⇒ 实现清单（照搬仓库既有惯例，`arguments.ts:105-106` 的原话是「strict 解析器要求在全局注册，run.ts 收集后透传给各命令，不污染其他命令的选项语义」）：

1. `arguments.ts` 的 `options` 里注册 `standard`（string）。**已核对：当前 50 个全局旗标里没有 `standard`** → 需新增。
2. `run.ts` 的 `switch (commandName(parsed.positionals))` 加 `case "standards"`，把 `parsed.values.standard` 收集后透传给 `runStandardsCommand(ctx, options, parsed.positionals.slice(1), {...})` —— **形状照抄 `memo-command.ts`**（它同样只有 `validate` 一个子命令）。
3. ⚠️ `zcode memo validate` **本身没有任何旗标**（`memo-command.ts:52-72` 只收一个位置参数）→ 新增 `--standard` **不会**破坏既有 memo 脚本；`zcode memo validate` 保持零旗标。

`zcode memo validate` **保留**，作为 `zcode standards validate --standard memo-v30` 的**薄封装**（行为、退出码、输出格式**一字不变**），避免破坏已有脚本。

### 7.1 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 通过（**含软违**：只记不拒） |
| `1` | 有硬违，或结构不合法，或标准 id 未知 |
| `2` | 文件读不到 / 不是合法 JSON |

与 `memo-command.ts` 现状一致（`MEMO_EXIT_OK=0` / `MEMO_EXIT_INVALID=1` / `MEMO_EXIT_IO_ERROR=2`）。

⚠️ **本命令面不产出结构化错误码**。`CapabilityErrorCode`（[`capability-registry.md`](./capability-registry.md) §3 的 8 值闭集）**不适用于** `zcode standards validate` —— 本 spec 刻意保留 `0/1/2` 三值退出码，因为 `zcode memo validate` 已经是既有对外契约（脚本按它分支）。因此：

- **本命令面没有 `error.code` 字段**，只有退出码 + 人读的 stderr / JSON 载荷；
- 这被登记为 `capability-registry.md` §7 的**明确例外**（`zcode standards validate` 的退出码 `0/1/2`）；
- 规则引擎**内部**不区分错误类型 —— 校验失败不是「错误」，是**结果**（`ok: false` + `violations`）。只有「标准 id 未知」「文件读不到」「JSON 非法」这三种**命令层**失败才对应退出码 `1` / `2`。
- **将来若要把规则引擎注册成能力键**（如 `standards.validate`），必须**同时**做三件事：IO 错误从 `2` 改 `1`、补 `130`（取消）/ `124`（超时）、删掉 `zcode standards validate` —— 只做一件就是对既有脚本的破坏性变更。→ 见 `capability-registry.md` §11 未决问题 7。

### 7.2 输出

文本模式四段（与 `formatTextReport` 现状一致）：`通过/不通过` 抬头 + `结构问题` + `硬违` + `软警告`。

JSON 模式：

```json
{
  "standard": { "id": "memo-v30", "version": "3.0" },
  "ok": false,
  "structureIssues": ["…"],
  "violations": [ { "id": "CF-02", "kind": "required_meta", "hard": true, "detail": "…", "hint": "…", "basis": "《…》第 3 条", "seq": 4 } ],
  "warnings": []
}
```

`memo validate` 的 JSON 载荷**保持原样**（不加 `standard` / `basis` 字段），`standards validate` 才带。

## 8. L4 执行编排

**引擎不管编排**。每个标准在 profile 之外另有一份**编排定义**（data，走既有 workflow 机制）：

- 动态工作流：`~/.zcode/cli/workflows/definitions/<id>.json`（既有形态，`workflow-expert-runtime-split.md`）。
- 专家工作流：`/expert` + `WorkflowDefinition` 契约。
- 简单场景：一段 prompt + 一个 skill。

**标准与编排的绑定**：profile 里加一个可选的 `orchestration` 字段（`{ kind: "dwf" | "expert" | "prompt", ref: string }`），让 `zcode standards describe` 能告诉使用者「跑这个标准用哪条流水线」。**引擎不执行编排**（保持 L4 与 L1~L3/L5 的解耦）。

## 9. 契约文件与漂移锁

延续 memo-v30 的做法：**契约文件是唯一真身**。

### 9.1 契约文件放哪（本期定死，避免出现两份 memo-v30 契约）

⚠️ **本期不新建 `docs/design/v2/standards/` 子目录**。现有契约文件是 `apps/zcode-cli/docs/design/v2/v30-memo.schema.json`，它被 **8+ 处引用**（`packages/shared/src/memo-v30/{schema,tables,index}.ts` 的注释、`packages/shared/test/memo-v30-contract-file.test.ts` 的路径、`apps/zcode-cli/docs/design/v2/memo-v30-contract.md`、`apps/zcode-cli/packages/cli/src/memo-command.ts` 的注释）。若再在 `standards/memo-v30.schema.json` 放一份，**同一个标准就有两份契约文件** —— 那正是本 spec 要消灭的东西（「真身」只能是唯一的那份）。

**约定**：

| 项 | 规则 |
| --- | --- |
| 目录 | **全部放 `apps/zcode-cli/docs/design/v2/` 顶层**，本期不建子目录 |
| 命名 | `<standard-id>.schema.json`（第二个标准起一律如此） |
| **memo-v30 的例外** | 沿用现名 **`v30-memo.schema.json`**，**不改名** —— 改名要动 8+ 处引用与漂移锁测试路径，且外部脚本可能按路径读它。它是**命名规则的唯一例外** |
| 什么时候集中 | 标准数超过 ~5 个、或出现「同名不同标准」的困扰时，再**一次性**迁移到 `docs/design/v2/standards/` —— 届时必须同步：移动文件 + 更新全部引用 + 更新漂移锁测试路径 + 跑一遍漂移锁确认绿。**迁移是一个提交，不许分批** |

### 9.2 漂移锁（⚠️ 当前是坏的，必须先修）

`packages/shared/src/standards/profiles/memo-v30.ts` 是**编译期副本**，漂移由测试锁住：

```
packages/shared/test/standards-contract-file.test.ts
```

沿用 `packages/shared/test/memo-v30-contract-file.test.ts` 的做法：测试读契约文件、比对 TS 副本的每一张表；任一表漂移 → 测试红。

⚠️⚠️ **但现有的漂移锁测试根本没跑**。实测：

| 事实 | 证据 |
| --- | --- |
| `packages/shared/package.json` **只有 `lint` / `lint:fix`，没有 `test` 脚本** | 读 `package.json` |
| `packages/shared` **连 `vitest` 依赖都没有**（devDeps 只有 `typescript` / `ws` / `@types/ws`） | 读 `package.json` |
| 根 `vitest.config.ts` 的 `engineering` project 的 `include` 是 `scripts/engineering-test-files.json` 的显式清单，其中 **`packages/shared/**` 0 条** | `grep -c "packages/shared" scripts/engineering-test-files.json` → `0` |

⇒ **`packages/shared/test/memo-v30-contract-file.test.ts` 与 `memo-v30.test.ts` 现在是死文件**。本 spec §9 的整个「真身 + 漂移锁」论证，**建立在一个当前不生效的锁上**。

**因此本 spec 的第 0 步是给 `packages/shared` 装上测试跑道**（二选一）：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A（推荐）** | 给 `packages/shared` 加 `vitest` devDep + `"test": "vitest run"` 脚本 | 干净；该包从此有独立入口，与 `apps/zcode-cli/packages/*` 各包的既有做法一致 |
| B | 把 `packages/shared/test/*.test.ts` 登记进 `scripts/engineering-test-files.json` | 零新依赖；但这些文件会进根工程门禁，需要适配根 `vitest.setup.ts` 与根别名 |

⚠️ 选 A 的话，**根工程门禁不会自动覆盖 `packages/shared`** → 需要把它接进 `pnpm verify:pre-push` 的受影响范围（照 `test:engineering:affected --scope push` 的既有机制），否则又是「本地能跑、门禁不跑」。

### 9.3 改名兼容

`evidence`→`items`、`page_ref`→`locator` 属于**骨架层改名**。契约文件里两个名字**都写**（旧名标 `deprecated`），TS 副本同时导出两套别名表，测试比对时**两套都要过**。

⚠️ **双读别名表不是「顺手加的」，是独立一步**：别名表要同时进契约文件、TS 副本、**和**引擎的规范化入口（§5.3）—— 少任何一处，「旧名也能读」就是假的。见 §13 实施顺序的第 3 步。

## 10. 状态所有者

| 状态 / 事件流 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 标准档案（表 / check / basis） | `packages/shared/src/standards/profiles/<id>.ts` | 编译期副本；真身是契约文件 |
| 契约文件 ↔ TS 副本的一致性 | `packages/shared/test/standards-contract-file.test.ts` | 漂移锁 |
| 通用求值器 | `packages/shared/src/standards/engine/checks.ts` | 只认 `kind`，不认具体标准 |
| 结构 schema | `packages/shared/src/standards/engine/structure.ts` | 由 profile 提供 |
| 文档规范化（骨架名 / 旧名） | `packages/shared/src/standards/engine/normalize.ts` | 入口做一次 |
| 校验入口 | `packages/shared/src/standards/engine/validate.ts` | 唯一出口 |
| CLI 命令与退出码 | `apps/zcode-cli/packages/cli/src/standards-command.ts` | 返回 exit code 给 `run.ts`，不调 `process.exit` |
| `zcode memo validate` 薄封装 | `apps/zcode-cli/packages/cli/src/memo-command.ts` | 行为不变 |
| 编排定义 | 既有 workflow 机制 | 引擎不碰 |

**避免的反模式**

- 不为每个标准复制一份 `cross-fields.ts`（那正是要消灭的东西）。
- 不在引擎里 `if (standard === "memo-v30")`（差异必须落在 profile 的数据里）。
- 不让 check 求值器直接 import 某个标准的常量表。
- 不在 CLI 层写标准专属的分支（`standards-command.ts` 只认 profile）。
- **不新增「profile 扩展」后门**（§4.1）—— 那是「规范一套」的反面。

**执行链路与 owner 图**（一次 `zcode standards validate` 的完整时序）

```
业务方 / 脚本
  │  argv: standards validate <file.json> [--standard memo-v30]
  ▼
CLI 层 (apps/zcode-cli/packages/cli/src/standards-command.ts)
  │  ① 读文件 + JSON.parse              ← 唯一的 IO 点（失败 → 退出码 2）
  │  ② 按 --standard 取 profile          ← 标准 id 未知 → 退出码 1 + 列出可用 id
  ▼
引擎入口 (packages/shared/src/standards/engine/validate.ts)
  │  ③ normalizeDocument(raw)            ← 旧名/骨架名规范化（§5.3），只做一次
  │  ④ profile 自检                      ← 不过 → 拒绝装载（§11）
  │  ⑤ L1 结构：profile.structure        ← 不过 → 返回 structureIssues，**不做 L2**
  │  ⑥ L2 跨字段：checks.ts 逐 kind 求值  ← hard 分流 violations / warnings
  │  ⑦ 附 L3 依据：profile.basis[check.id]
  ▼
结果对象 StandardValidationResult
  │
  ▼
CLI 层投影 → 文本四段 / JSON 载荷  →  退出码 0 / 1
```

**事件顺序约束**

1. **结构层先于跨字段层**（L1 → L2）：结构不合法时**不做**跨字段求值 —— 否则报错会指向不存在的字段。
2. **规范化只做一次**，在引擎入口；所有求值器只见规范化后的骨架。
3. **profile 自检在装载时**，不在校验某份文件时 —— 坏 profile 是**部署问题**，不是用户数据问题。
4. **`basis` 只附加、不参与判定**：条文依据是给人看的，不影响 `ok`。
5. **退出码只在 CLI 层产生**：引擎返回结果对象，不认识退出码、不调 `process.exit`。
6. **`zcode memo validate` 与 `zcode standards validate` 走同一条链**，前者只是薄封装（§7）—— **不允许出现第二条实现路径**。

**避免的反模式**

## 11. 错误语义

| 情形 | 行为 |
| --- | --- |
| 标准 id 未知 | stderr 一行 + 列出可用 id；退出码 `1` |
| profile 缺必需字段（如 `outputModeByType` 少了某个 itemType） | **启动即失败**（profile 自检），不等到校验某份文件才炸 |
| 结构不合法 | 返回 `structureIssues`，**不做跨字段求值** |
| 有硬违 | `ok: false`，退出码 `1` |
| 只有软违 | `ok: true`，退出码 `0`，软违在 warnings 里照常输出 |
| 文件读不到 / 非法 JSON | 退出码 `2` |

**profile 自检**：注册 profile 时跑一遍「`outputModeByType` 的键集 = `itemTypes` 的键集」「每个 `requiredMeta` 的键都在 `metaLabels` 里（`metaLabels` 可缺，缺则原样保留）」「每个 `crossFieldChecks[].id` 在 `basis` 里有依据（`basis` 可缺）」。不满足 → **拒绝装载该 profile**，报明确错误。**宁可没有这个标准，也不要一个半残的标准。**

## 12. 验收

**工程测试 —— 按包的真实入口跑**：

⚠️ **`pnpm test:engineering <file>` 到不了这些测试**。根 `vitest.config.ts` 的 `engineering` project 的 `include` 是 `scripts/engineering-test-files.json` 的**显式清单**，其中 **`apps/zcode-cli/**` 与 `packages/shared/**` 各 0 条**；而且匹配不到文件时**不报错**（只打印 "No test files found"）→ **门禁形同虚设**。

⚠️ **`packages/shared` 现在连测试入口都没有**（无 `test` 脚本、无 `vitest` 依赖，§9.2）→ **本 spec 的实现与验收全在这个包里**，所以**第 0 步必须先给它装上跑道**，否则后面每一步都「写完了但没人跑」。

| 包 | 入口 | 新增测试文件要做什么 |
| --- | --- | --- |
| `packages/shared` | **待建**（§9.2 方案 A：`pnpm --filter @zcode/shared test` = `vitest run`） | ⚠️ **先建入口再写测试**；新文件放进 `packages/shared/test/` |
| `apps/zcode-cli/packages/cli` | `pnpm --filter @zcode/cli test`（= `node --test` + **显式文件清单**） | ⚠️ **必须把新测试文件加进 `packages/cli/package.json` 的 `scripts.test` 文件列表** |
| `apps/zcode-cli/packages/contracts` | `pnpm --filter @zcode/contracts test`（= `vitest tests`） | 放进 `packages/contracts/tests/` |
| `apps/zcode-cli/packages/core` | `pnpm --filter @zcode/core test`（= `vitest tests`） | 放进 `packages/core/tests/` |
| `apps/zcode-cli/packages/adapters` | `pnpm --filter @zcode/adapters test`（= `vitest tests`） | 放进 `packages/adapters/tests/` |

**引擎组**（纯函数，无外部依赖 → 进 CI）：

| 场景 | 断言 |
| --- | --- |
| 引擎通用性 | 用**一个假 profile**（不是 memo-v30）跑 8 种 kind → 各自按预期产出违规 |
| 引擎通用性 | 同一份文档 + 两个不同 profile → 违规集合不同（证明没有硬编码标准） |
| **memo-v30 行为不变** | 改造后 `packages/shared/test/memo-v30.test.ts` 的**全部既有断言照过**（detail 关键片段、退出码、JSON 字段集） |
| 双读兼容 | `evidence` 旧名与 `items` 新名产出**完全相同**的校验结果 |
| 硬违 / 软违分流 | `hard: false` 的 check 只进 warnings，`ok` 仍为 `true` |
| 逐件 vs 整份 | 逐条 check 的违规带 `seq`；整份级的不带 |
| L3 依据 | `basis` 出现在违规对象里；memo-v30 的既有输出**不**因为它多出字段而变化 |
| 披露逐件性 | `perItemDisclosureReasons` 里的原因缺 `seq` → 结构层报错 |
| profile 自检 | `outputModeByType` 键集 ≠ `itemTypes` 键集 → 装载被拒 |
| 契约漂移锁 | 契约文件里改一张表而 TS 副本没跟上 → 测试红 |
| 命令面 | `standards list` / `describe` / `validate` 的 stdout 与退出码；标准 id 未知 → 退出码 1 + 列出可用 id |
| 封装不回归 | `zcode memo validate` 的退出码仍是 0/1/2，`--json` 载荷字段集不变 |
| **漂移锁真的在跑** | ⚠️ 回归 §9.2：先断言「`packages/shared` 有 test 入口且 `pnpm --filter @zcode/shared test` 真的跑到了 `memo-v30-contract-file.test.ts`」—— 防止再次出现「测试文件在，但没人跑」 |
| **双读别名表齐了** | 契约文件里有旧名 + 新名、TS 副本导出两套别名表、引擎规范化认旧名 —— **三处缺一即红**（§9.3） |

**不测**：真实法律条文的正确性（那要人审）；`basis` 引用的条文是否现行有效。

## 13. 实施顺序

每步一个提交。

0. **给 `packages/shared` 装测试跑道**（§9.2 方案 A：加 `vitest` devDep + `"test": "vitest run"`），并把它接进 `pnpm verify:pre-push` 的受影响范围。**先跑一遍现有的 `memo-v30.test.ts` 与 `memo-v30-contract-file.test.ts` 确认绿** —— 它们今天没跑过，第一次跑**可能暴露既有的失败**，那属于「先修红的、再动新的」，不是本 spec 的锅。
1. `packages/shared/src/standards/contract.ts`：profile / check / violation 类型。
2. `packages/shared/src/standards/engine/checks.ts`：8 种 kind 的**通用**求值器（从 profile 取表）。
3. **双读别名表**（§9.3）—— **这一步独立成提交，且三处一起改**：契约文件里同时写旧名 + 新名（旧名标 `deprecated`）、`packages/shared/src/standards/profiles/memo-v30.ts` 同时导出两套别名表、`packages/shared/src/standards/engine/normalize.ts` 的规范化入口认旧名。少改一处，「旧名也能读」就是假的。
4. `packages/shared/src/standards/engine/normalize.ts`：骨架 / 旧名规范化（第 3 步已建骨架，这一步补完 + 单测）。
5. `packages/shared/src/standards/engine/validate.ts`：两层入口 + profile 自检。
6. `packages/shared/src/standards/profiles/memo-v30.ts`：把 `memo-v30/` 的表搬成 profile（**行为逐字不变**）。
7. `packages/shared/src/standards/engine/structure.ts`：结构 schema 由 profile 提供（先接 zod 镜像）。
8. `zcode standards` 命令面 + `zcode memo validate` 改薄封装。
9. **契约文件 + 漂移锁测试**（`packages/shared/test/standards-contract-file.test.ts`）。⚠️ 契约文件**留在 `docs/design/v2/` 顶层**、memo-v30 沿用现名 `v30-memo.schema.json`（§9.1）—— **本期不新建 `standards/` 子目录**，避免两份 memo-v30 契约并存。
10. 第二个标准（用来证明「一套」真的通）—— **候选：律所内部的「证据清单」标准**（比 memo-v30 简单：只有条目列表 + 必填要素）。

## 14. 未决问题

1. **第二个标准选哪个？** 需要一个真实的、不是「为了演示而造」的标准 → **需要用户给一个**。候选：证据清单、合同审查意见、法律文书。→ 定下来才能验证「一套」是真的可复用。
2. **L3 条文依据是纯字符串还是结构化？** 纯字符串够用但无法机器校验（条文是否现行）。结构化（`{ source, article, version }`）能接外部条文库 → 倾向**先纯字符串**，接口留位。
3. **`basis` 缺失时怎么办？** profile 自检说「可缺」。缺依据的 check 照常执行，但违规输出里没有 basis → 用户看到「无依据」要能一眼看出。→ 违规输出里 basis 缺失时显示「（无依据）」，不省略字段。
4. **结构层要不要支持纯 JSON Schema（不用 zod）？** zod 是仓库既有依赖；但标准作者写 JSON Schema 更普遍。→ 支持两者：profile 的 `structure` 接受 zod schema **或** JSON Schema 对象，引擎择一。
5. **跨 workspace 的标准复用？** 标准档案是**代码/数据**，随包分发，不随 workspace 走 → 天然隔离。
6. **「规范一套」是否也包括**统一的**产出物目录结构 / 命名规范**（文件放哪、叫什么）？→ 那是交付层，另议。
