# 能力注册表与三投影（CLI / MCP / 内置工具）

## 1. 目的与范围

把 ZCode 已有的能力（文档解析、OCR、多模态识别、规则校验）收进**一套注册表**，一次实现、三处投影：

> **知识检索与本地资产管理不在此列** —— 前者是 runtime 子系统，后者是基础设施，两者的理由见 §1 后两段。

- **投影 A — CLI**：`zcode <capability>` 子命令，人和脚本都用它。
- **投影 B — MCP**：把能力暴露成 MCP tool，让 dsh / Claude Code / 任何 MCP 宿主直接用（见 `plugin-compat.md`）。
- **投影 C — 内置工具**：注册成 ZCode 自带的 tool，Agent 在会话里直接调。

**本 spec 只定义契约、注册表与投影机制**，不定义各个能力自身的业务规则。那些各自成篇：

| 能力 | spec | 状态 |
| --- | --- | --- |
| 本地 OCR | [`ocr-local.md`](./ocr-local.md) | 本轮写 spec（含图像预处理：倾斜校正 / 去噪 / 去阴影 / 去色彩 / 二值化；默认只做倾斜校正，其余四步保留在契约里但不启用） |
| 本地资产（模型 / 语言包）管理 | [`model-assets.md`](./model-assets.md) | 本轮写 spec（ZCode 托管语言包；`zcode asset` 命令组；**不是能力**，见下） |
| 客户端本地知识库（Runtime 内置 RAG） | [`knowledge-rag.md`](./knowledge-rag.md) | 本轮写 spec |
| 统一规范规则引擎 | [`standard-rule-engine.md`](./standard-rule-engine.md) | 本轮写 spec |
| 文档解析 | 已有 `office-runtime`（`packages/office-runtime`） | 无需新 spec |
| 图片识别 | 已有 [`image-recognition-cli.md`](./image-recognition-cli.md) | 无需新 spec |
| 结果交付（Excel / 报告） | 复用 `apps/zcode-cli/packages/spreadsheets-plugin/skills/xlsx/xlsx.py` | **本批未覆盖** —— 交付契约（产出物形态 / 目录 / 命名）尚无 spec；[`standard-rule-engine.md`](./standard-rule-engine.md) §14 第 6 条明确「那是交付层，另议」。**不要**按本行去实现 |
| 智能体（工作流 / 多 Agent） | 无 | **本批未覆盖** —— 需另写 spec。本注册表只提供「一次实现三投影」的能力机制，不提供编排 |
| 音视频 / 流媒体 / 硬件输入 | 已有 [`multimodal-platform.md`](./multimodal-platform.md) 族 spec（`audio-input.md` / `video-frames.md` / `stream-input.md` / `hardware-sensor.md`） | **本批未覆盖**；且其中的 whisper 模型归属见 [`model-assets.md`](./model-assets.md) §1 的边界说明 |

⚠️ **知识检索不是能力键，是 runtime 子系统**。按用户定的方向（客户端本地优先、服务端只是补充），本地知识库住在 ZCode runtime 里、由 runtime 每轮自动消费（`relevant_knowledge` 注入 + `KnowledgeSearch` 工具），它**不进**本注册表、**不投影**成任何能力命令（⚠️ `zcode cap run` 已整体作废，见 §4.2 横幅）。它的离线动作（建索引 / 查索引）以 `zcode knowledge index|search` 子命令单独暴露——理由见 [`knowledge-rag.md`](./knowledge-rag.md) §17。

⚠️ **本地资产管理同样不是能力**。语言包 / 模型权重的下载、校验、切换（[`model-assets.md`](./model-assets.md)）**不进**本注册表、**不做**三投影 —— 它的使用者是人和运维，不是 agent，所以只有 `zcode asset ...` 一条 CLI 表面。这与知识检索「不投影成能力」是同一类判断，但理由不同：知识检索是 runtime 子系统，资产管理是**基础设施**。

⚠️ **本地资产命令面是平级的 `zcode asset`**，与 `zcode ocr` 并列、**不嵌套在其下**（见 [`local-infra.md`](./local-infra.md) §7.3）—— CLI 原子化：一个能力域一个命令组；资产跨能力域共享，不该挂在 OCR 之下。资产层的规格仍在 [`model-assets.md`](./model-assets.md)。

**不适用**

- 不替换 `zcode recognize` / `zcode memo validate` 等**已存在的旗舰子命令**（见 §4.3 的迁移策略）。
- 不改变 `packages/core` 的 agent loop、不引入新的 tool 权限模型。
- 不做远程能力注册（能力实现必须本地可执行）。

## 2. 两套命名空间，别混

仓库里已有两件容易撞名的事，本 spec 明确区分：

| 概念 | 键空间 | 载体 | 语义 |
| --- | --- | --- | --- |
| **模型能力位** | `image` / `pdf` / `video` | `MODEL_CAPABILITIES`（`packages/shared/src/model-selection.ts`） | 「这个**聊天模型**能不能直接吃这类输入」→ 决定 `--capability image=xxx` 选谁 |
| **能力键** | `ocr` / `doc.parse` / `vision.describe` … | 本 spec 的 `CapabilityRegistry` | 「这件**事**怎么做」→ 决定调哪个 `execute` |

两者会重叠（`ocr` 的实现内部可能要用视觉模型复核），但**不是一回事**：`--capability` 这个旗标继续只管模型能力位，**不改语义**；能力键是**注册表**里的概念（`CapabilityRegistry`），⚠️ **2026-11-12 起不再有 `zcode cap run <key>` 这条命令** —— CLI 面发的是**积木 id**（`ocr.inspect` / `ocr.parse` / …，见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §5.1 的闭集）。⚠️ **积木 id 与能力键是两个命名空间**：一个能力键（`ocr`）可对应多个积木；MCP / 内置工具投影仍发能力键，CLI 投影发积木 id（**有意的差异**，不是漂移）。

⚠️ **`--capability` 这个旗标名已被占用，不要复用**。既有实现见 `apps/zcode-cli/packages/cli/src/capability-override.ts`：全局 multiple 旗标，取值形态是 `<能力键>=<模型类型名>`（如 `--capability image=xxx`），且能力键必须 ∈ `MODEL_CAPABILITIES`。若投影 C 要「显式启用某个能力」，**另起旗标名**（如 `--enable-capability <key>`），不要与它撞名 —— 两者取值形态完全不同。

⚠️ `MODEL_CAPABILITIES` 目前只有 `["image"]`，`packages/provider/src/model-selection-types.ts:171-181` 的 `modelSupportsCapability` 也只认 `image`。本期**不动**这个枚举（`ocr` 用本地引擎不需要模型；知识检索是纯词法，不需要嵌入模型——见 [`knowledge-rag.md`](./knowledge-rag.md) §1.4）。扩展它留到 §11。

## 3. 能力契约

```ts
// apps/zcode-cli/packages/capabilities/src/contract.ts
import type { ZodTypeAny } from "zod";

/** 能力键（点分小写）。全局唯一，注册时查重。 */
export type CapabilityKey = string;

/** 能力的副作用面 —— 权限系统读它，不靠调用点猜。 */
export type CapabilitySideEffects = "none" | "workspace" | "network" | "system";

/** 能力调用的上下文。能力实现只从这里拿依赖，不自己 new。 */
export interface CapabilityContext {
  /** 全链路追踪 id（AGENTS.md：所有任务都必须携带可传播的 traceId）。 */
  readonly traceId: string;
  /** 工作区隔离键：`workspaceIdentity?.trim() || workspacePath`。 */
  readonly workspaceKey: string;
  readonly workspacePath: string;
  readonly storageRoot: string;
  readonly signal?: AbortSignal;
  readonly logger: CapabilityLogger;
  /** 已装配的端口集合（能力实现只经端口做 I/O，不直接碰 fs / child_process / fetch）。 */
  readonly ports: CapabilityPorts;
  /** 进度回调（可选）。流式进度不进信封，由投影层决定渲染方式。 */
  readonly onProgress?: (progress: CapabilityProgress) => void;
}

/** 进度事件。`total` 未知时为 undefined。 */
export interface CapabilityProgress {
  readonly phase: string;              // "render" | "preprocess" | "recognize" | …
  readonly current?: number;
  readonly total?: number;
  /** 人类可读的一行说明（不进日志，仅供投影层渲染）。 */
  readonly message?: string;
}

/** 能力实现用的日志器。⚠️ **不得**用 `console.log` 或 `window.zcode?.log`（AGENTS.md）。 */
export interface CapabilityLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** `registry.list()` 的条目摘要。 */
export interface CapabilitySummary {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly sideEffects: CapabilitySideEffects;
}

/**
 * 能力可用的端口集合。
 * ⚠️ 这里只列**本 spec 涉及的**能力要用的端口；每加一个能力就往这里加一项，
 * 不要让能力自己 new 端口。
 */
export interface CapabilityPorts {
  /** 本地 OCR 引擎（`ocr-engine.port.ts`）。 */
  readonly ocrEngine: OcrEnginePort;
  /** 图像预处理（`image-preprocess.port.ts`）。 */
  readonly imagePreprocess: ImagePreprocessPort;
  /** 本地资产（`local-asset.port.ts`）。 */
  readonly localAsset: LocalAssetPort;
  /**
   * 本地基础设施（`local-infra.port.ts`）—— 解析档位链 / 产物 / 降级。
   * ⚠️ **档位选择与降级决定归这个端口**（见 [`local-infra.md`](./local-infra.md) §5.1），
   * 能力层不自己探环境、不自己选引擎。
   */
  readonly localInfra: LocalInfraPort;
  /** 子进程执行（既有 `execution.port.ts`）。 */
  readonly execution: ExecutionPort;
  /** 文件系统（既有 `file-system.port.ts`）—— 原子写、临时文件、目录遍历都走它。 */
  readonly fileSystem: FileSystemPort;
}

/** 失败码。能力实现抛错时必须带其中之一。 */
export type CapabilityErrorCode =
  | "unsupported_input"      // 输入类型/形状不对
  | "invalid_input"          // 输入合法形状但值非法
  | "unavailable"            // 依赖缺失（tesseract 没装）
  | "not_found"              // 目标文件/条目不存在
  | "permission_denied"      // 权限层拒绝
  | "cancelled"              // 用户取消
  | "timeout"                // 超时
  | "internal";              // 兜底：不该发生的

export interface CapabilityError {
  readonly code: CapabilityErrorCode;
  readonly message: string;      // 中文，可直接给用户看
  readonly hint?: string;        // 可处置提示
  readonly details?: Record<string, unknown>;
}

/** 统一结果信封。能力**不抛裸异常**给 CLI 层（除取消/编程错误）。 */
export interface CapabilityResult<T = unknown> {
  readonly ok: boolean;
  readonly key: CapabilityKey;
  readonly output?: T;
  readonly error?: CapabilityError;
  readonly metrics?: {
    readonly durationMs: number;
    readonly items?: number;
    readonly warnings?: readonly string[];
  };
}

/** 一个能力的定义。 */
export interface CapabilityDefinition<P = unknown, T = unknown> {
  readonly key: CapabilityKey;
  readonly title: string;
  readonly description: string;
  /**
   * 输入 schema —— **zod runtime schema 是唯一源**。
   * 三个投影在各自的输出边界调 `toToolJsonSchema()`（既有 `packages/contracts/src/tools/json-schema.ts`）派生 JSON Schema，
   * 不为投影另写一份 schema。
   */
  readonly inputSchema: ZodTypeAny;
  readonly outputSchema: ZodTypeAny;
  readonly sideEffects: CapabilitySideEffects;
  /** 幂等：同样的输入重复执行不产生额外副作用。 */
  readonly idempotent: boolean;
  /** 是否有副作用（写文件 / 发网络）。true 时投影层必须走权限。 */
  readonly mutating: boolean;
  execute(context: CapabilityContext, input: P): Promise<CapabilityResult<T>>;
}
```

**契约纪律**

- `execute` **不抛** `CapabilityError` 之外的异常；真抛了由投影层兜成 `internal`。
- `execute` 返回的 `output` 必须能被 `outputSchema` 校验通过（投影层在返回前校验，失败兜成 `internal`）。
- 能力实现**只经 `context.ports` 做 I/O**。这是 AGENTS.md「外部 I/O 边界收敛」的落点：OCR 的子进程都在端口后面。
- ⚠️ **schema 单一来源**：zod runtime schema 是唯一源，JSON Schema 一律由 `toToolJsonSchema()` 派生（对齐 `tool/00-tool-change-chain.md` 的既有约定）。能力定义里**不手写** JSON Schema。
- ⚠️⚠️ **zod 版本必须对齐 —— 用 `contracts` 那份 zod（3.x），不是仓库里的 zod 4**。仓库现在**两个 zod 主版本并存**：

  | 包 | zod | 证据 |
  | --- | --- | --- |
  | `apps/zcode-cli/packages/contracts` | **3.25.76** | `package.json` 写 `^3.24.0`；另有 `zod-to-json-schema@3.25.2` |
  | `packages/shared` / `packages/provider` / `apps/zcode-cli/packages/{adapters,bootstrap}` | **4.6.5** | `package.json` |

  `ZodTypeAny` 与 `toToolJsonSchema()`（`packages/contracts/src/tools/json-schema.ts:54`，签名 `(schema: ZodTypeAny) => JsonSchema`）都来自 **contracts 的 zod 3**。

  ⇒ **zod 4 构造的 schema 传不进 `toToolJsonSchema`**。实测（tsc 6.0.2）：

  ```
  error TS2740: Type 'ZodObject<{ a: ZodString; }, $strip>' is missing the following
  properties from type 'ZodType<any, any, any>': _type, _parse, _getType,
  _getOrReturnCtx, and 7 more.
  ```

  ⇒ **能力契约所在的包（无论走 §6 的路线 (a) 还是 (b)）必须用 contracts 那份 zod 构造 `inputSchema` / `outputSchema`**。若能力实现放在用 zod 4 的包里（`core` / `adapters` / `shared`），**它不能自己 `import { z } from "zod"` 造 schema 传进契约** —— 要么从契约包导出 schema 工厂，要么该包也用 zod 3。

  ⚠️ 别用 `as any` / `as unknown as ZodTypeAny` 绕过 —— 那会让运行时 schema 与声明类型脱节，`toToolJsonSchema` 的输出可能不是合法 JSON Schema，而错误要到 MCP 客户端才炸。
- ⚠️ **对外错误码只有一个闭集**：`error.code` 只允许取 `CapabilityErrorCode` 的 8 个值。引擎层 / 资产层的细粒度码（`engine_unavailable` / `language_missing` / `corrupted` / `process_failed` …）**一律归一到能力码**，原始码放 `details.engineCode` / `details.assetCode`。映射表见 §7。

## 4. 注册表与三投影

### 4.1 注册表

```ts
// apps/zcode-cli/packages/capabilities/src/registry.ts
export interface CapabilityRegistry {
  register(definition: CapabilityDefinition): void;   // 重复键抛错
  get(key: CapabilityKey): CapabilityDefinition | undefined;
  list(): readonly CapabilitySummary[];               // key / title / description / sideEffects
}

export function createCapabilityRegistry(): CapabilityRegistry;
```

注册表是**进程内单例**（bootstrap 装配时填充），不是配置文件驱动的动态注册。理由：能力的 `execute` 是代码，不是数据；配置驱动的是**参数**（引擎路径、模型名），不是能力本身。

### 4.2 投影 A — CLI

> ⚠️⚠️ **2026-11-12 已被 [`capability-cli-blocks.md`](./capability-cli-blocks.md) 取代（§4.2 全部内容）**。
>
> **用户拍板**：**CLI 是交给业务调用的积木**，业务拿原子命令自己封装场景逻辑 ⇒ **投影 A 不是 `zcode cap run` 通用执行面，而是族命令组**（`zcode ocr inspect` / `zcode ocr parse` / …）。理由与完整形态见新 spec 的 D1 / D4。
>
> - ⛔ **不实现** `zcode cap list` / `zcode cap describe` / `zcode cap run`；
> - ✅ **沿用**本 spec 的 §3 能力契约、§7 退出码与错误码闭集、§8 输出信封（业务要写一套解析器，这三样是对外公共契约）；
> - ✅ **沿用** §4.1 注册表与 §4.5「三投影共用一份实现」（族命令组是注册表的一个投影，不是第二份实现）；
> - ⏸ §4.3 MCP 投影保留（给 dsh 这类 MCP 宿主），但**不是**业务主接入面。
>
> 下文保留作历史记录，**实施时以新 spec 为准**。

```
zcode cap list
zcode cap describe <key>
zcode cap run <key> [--input <file>] [--json] [--param k=v ...]
```

- `cap list` / `cap describe` 是发现面：让人（和 agent）知道有什么、参数是什么。
- `cap run` 是统一执行面：`--input` 给一个**能力输入 JSON 文件**（或 `-` 读 stdin）；`--param k=v` 传标量参数（v1 只支持 string / number / boolean）。
- ⚠️ **`--input` 的语义只有一种：能力输入 JSON**。**不要**让它直接接一个 PDF / 图片路径 —— 那会让 `--input` 在「JSON 文件」与「待处理文件」之间变成两义，业务方照不同文档写代码必然有一边失败。要传文件路径，就放进输入 JSON 的字段里：

  ```
  zcode cap run ocr --input ocr-request.json --json
  # ocr-request.json: { "path": "扫描件.pdf" }     ← path 相对 workspace 根
  ```

  批量输入（多文件 / 目录）如果要做，**另起旗标**（如 `--input-dir`），**不得**复用 `--input` 改语义。
- **不新增子命令路由到每个能力**——那会让 `zcode --help` 随能力数量线性膨胀，且参数无法统一校验。
  - ⚠️ **2026-11-12 已被推翻**：族命令组是**业务接入面**，正是「新增子命令路由到每个能力」。→ 见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D4。

**接入点（既有四件套，缺一不可）**：

1. `apps/zcode-cli/packages/cli/src/capability-command.ts` —— 命令实现（依赖注入 + 返回 exit code，**不调 `process.exit`**）。
2. `apps/zcode-cli/packages/cli/src/arguments.ts` —— 全局 `parseArgs({strict:true})` 里注册 `--input` / `--param`（multiple）。既有注释口径：strict 解析器要求旗标在全局注册，`run.ts` 收集后透传给各命令，**不污染其他命令的选项语义**。⚠️ **已核对当前 50 个全局旗标**：`input` / `param` **均不存在** → 需新增；而示例里的 `--json` **已存在**（`usage` / `plugins` 在用）→ **直接复用，不要重复注册**（同一 schema 里出现两个同名 key 会直接抛重复键错误）。
3. `apps/zcode-cli/packages/cli/src/run.ts` —— 加 `case "cap"` 分派；`<key>` 取**位置参数**（`parsed.positionals`），**不是** `--key` 选项。
4. help 文案（`zcode --help` 与 `zcode cap --help`）。

⚠️ ~~**投影 A 是业务客户端的主接入面**。交付形态已定为「业务客户端同机 + 子进程调 `zcode cap run`」~~ → ⚠️ **2026-11-12 修订**：业务方调的是**族命令组积木**（`zcode ocr parse --path …`），不是 `zcode cap run`（见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D4）。**信封与退出码仍是对外公共契约**（§7 / §8 沿用），只是 §8 的 `key` 在 CLI 面取**积木 id**（§5.1 闭集）。投影 B / C 是 ZCode 内部自用的便捷面，不承担对外兼容性承诺。

### 4.3 投影 B — MCP

MCP 投影复用仓库已有的插件形态：一个 stdio MCP server，每个能力一个 tool。

- 工具名 = 能力键（`.` 换成 `_`，MCP 工具名不接受点号）。
- `inputSchema` 由能力定义的 zod schema 经 `toToolJsonSchema()` 派生 —— **不为投影另写一份 schema**。
- `outputSchema` 投影为 MCP `structuredContent`（参考 `apps/zcode-cli/packages/core/tests/mcp-structured-content-projection.test.ts` 的既有投影约定）。
- server 进程只依赖 `ZCODE_WORKSPACE_ROOT`（与 `pdf-plugin/.zcode-plugin/plugin.json` 的 `mcpServers` 约定一致）。

⚠️ **server 的落点：不在业务包里拉起 stdio server**。`architecture.md` §1.2 明确「`bootstrap/` 是**唯一**允许把 core 和 adapter 组装到一起的地方」—— 业务包自己起 server 进程 = 业务层做组合根的事。两条合规路线，**选一条写死**：

- **(a) 放 `packages/bootstrap/src/app/`**（与既有的 `mcp-node-fallback.ts` 等并列），由 CLI 入口拉起。
- **(b) 做成插件包**（`.zcode-plugin/plugin.json` + `mcpServers`），并登记进 `packages/bootstrap/src/app/official-plugin-definitions.ts` 的 `OFFICIAL_PLUGIN_DEFINITIONS` —— 这样用户能安装 / 禁用 / 发现这批 MCP tool。

⚠️ 选 (b) 时注意 `office-runtime` **不是**先例：它是**插件包**（有 `module.ts` / `contract.ts` / `contract.example.ts` / `CONTRACT.md` + 构建期逐插件打包），不是四层模型里的普通库包。

**`ZCODE_WORKSPACE_ROOT`（既有约定，非新增）**：仓库里已有 5 处在用（`pdf-plugin/.zcode-plugin/plugin.json` 等），本 spec 只沿用。约定补全：

| 项 | 约定 |
| --- | --- |
| 用途 | 指定 MCP server 进程的工作区根目录 |
| 优先级 | 启动时由宿主注入 > 进程工作目录兜底 |
| 错误行为 | 未设置且工作目录不可解析 → server 启动即报错退出（**不静默用 `/`**） |
| 测试覆盖 | 由该 MCP 插件包自己的工程测试覆盖（见 §9 的入口说明） |

**迁移策略**：新能力走 `zcode cap` + MCP 投影；**已存在的旗舰子命令保持不动**（`zcode recognize` 有独立的五级模型优先链和接地不变量，套进通用契约会丢语义）。等通用契约成熟后再逐个把旗舰命令改成薄封装。

### 4.4 投影 C — 内置工具

能力注册成 ZCode 内置 tool：tool 名 = 能力键（同样点号换下划线），schema 同源（zod → `toToolJsonSchema` 派生）。

⚠️ **投影 C 不是一个「薄封装」，它必须逐字段对上 `ToolEntry`**（`apps/zcode-cli/packages/core/src/tool/types.ts:324`，`extends ToolContractDeclaration` = `apps/zcode-cli/packages/contracts/src/tools/contract.ts:168`）。只写「按 `sideEffects` / `mutating` 映射到既有权限层」是不够的 —— 下面这些字段一个都不能漏。

⚠️⚠️ **字段是分层的，不都在顶层**。真实结构：

```
ToolEntry
├─ metadata: ToolMetadata              ← core/src/tool/types.ts:71（大部分行为标志在这里）
│    name / description? / modelInstructions? / allowedInPlanMode? / readOnly /
│    destructive / concurrentSafe / requiresUserInteraction? / timeoutMs? /
│    maxOutputBytes? / sideEffectScope / riskLevel / needsApproval / providerVisible? / …
├─ capability: string                  ← contracts/src/tools/contract.ts:170
├─ inputSchema / outputSchema: JsonSchema（Record<string, unknown>）  ← **不是 zod**
├─ runtimeInputSchema? / runtimeOutputSchema?: unknown   ← core/src/tool/types.ts:426-427（zod 等校验器）
├─ permission: ToolPermissionSpec      ← { permission, reason, riskLevel, sideEffectScope,
│                                           needsApproval, patternSources, denyPriority, alwaysAsk? }
├─ resultBudget / timeout / cancellation / trace
└─ handler / formatModelContent / …
```

⇒ **`sideEffectScope` / `riskLevel` / `needsApproval` 在两处都出现**：`metadata.*`（给模型看的行为描述）与 `permission.*`（给权限层执行的）。**两处都要填，且必须一致** —— 只填一处会出现「模型看到一个范围、权限层按另一个范围判」的错位。

| `ToolEntry` 路径 | 能力侧来源 | 说明 |
| --- | --- | --- |
| `metadata.name` | 能力键（点号换下划线） | snake_case |
| `metadata.description` | `description` | |
| `metadata.modelInstructions` | **额外撰写** | `readonly string[]`（**数组，不是字符串**，`core/src/tool/types.ts:77`）—— 说明何时该调、何时不该调 |
| `metadata.readOnly` | `!mutating` | 写 sidecar 的能力 → `false` |
| `metadata.destructive` | 恒 `false` | v1 没有破坏性能力；将来「覆盖文本层」类能力要重估 |
| `metadata.concurrentSafe` | 由能力声明 | OCR 写 sidecar → `false` |
| `metadata.requiresUserInteraction` | 恒 `false` | v1 能力不向用户提问 |
| `metadata.allowedInPlanMode` | 恒 `true` | 规划模式只读，不调 OCR |
| `metadata.sideEffectScope` | `sideEffects` | 类型是 **`ModelToolSideEffectScope`**（`contracts/src/model/index.ts:478`），不是 `ToolSideEffectScope`。两者成员集合相同（`none`/`workspace`/`git`/`network`/`system`/`session`/`userInteraction`），可互换赋值，但**分属两处声明** —— 别引错 |
| `metadata.riskLevel` | 由 `sideEffectScope` 派生 | `RiskLevel` = `low` \| `medium` \| `high` \| `critical`（`contracts/src/interfaces/session.port.ts:65`） |
| `metadata.needsApproval` | 由 `sideEffectScope` 派生 | `workspace` 写 → 走既有工作区写权限 |
| `metadata.timeoutMs` / `metadata.maxOutputBytes` | 按能力定 | 与 `timeout` 策略配套 |
| `capability` | **一句英文散文**（不是能力键！） | ⚠️ 见下方说明 |
| `inputSchema` / `outputSchema` | **zod 派生出的 JSON Schema** | 能力侧存 zod；`ToolEntry` 侧存 `toToolJsonSchema()` 的产物（`Record<string, unknown>`） |
| `runtimeInputSchema` / `runtimeOutputSchema` | **同一个 zod schema** | ⚠️ 必须同时提供，否则内置 tool 缺运行时校验（既有断言 `tool-contract-assertions.ts:15-16` 要求每个注册 tool 都非空） |
| `permission` | 既有权限层 | `ToolPermissionSpec` —— 复用，不自造。⚠️ 其中的 `riskLevel` / `sideEffectScope` / `needsApproval` 要与 `metadata` 里的**保持一致** |
| `resultBudget` | **按能力定** | ⚠️ OCR 逐页文本可达 MB 级 → **必须落 artifact，只回摘要 + 预览 + 引用**，不回灌模型上下文 |
| `timeout` / `cancellation` | 能力实现 | ⚠️ **tesseract 路线**：单页 120s / 整批 30min（见 `ocr-local.md` §8）。⚠️ **MinerU 路线不适用这套预算** —— 一份 300 页 PDF 会远超 30min，照抄会**静默杀掉合法任务**；MinerU 的预算按「冷启动基线 + 页数 × 单位额度」算（[`local-infra.md`](./local-infra.md) §7.8） |
| `trace` | `context.traceId` | 全链路可传播 |
| `handler` / `formatModelContent` | 投影层 | 调 `execute` 并把结果投影成模型可读内容 |

⚠️⚠️ **`capability` 字段不是「能力键」，也不是模型能力位** —— 这是最容易写错的一处。

- 真实类型：`ToolContractDeclaration.capability: string`（**必填**，`contracts/src/tools/contract.ts:170`），落到 `ModelToolContract.capability?: string`（`contracts/src/model/index.ts:491`）。
- 既有 handler **一律填英文散文**，不是标识符：

  ```ts
  // core/src/tool/handlers/read.ts:566
  capability: "Read text files and supported images from the file-system adapter without modifying files",
  // core/src/tool/handlers/todo.ts:75
  capability: "Read the current session todo list without modifying external state",
  ```

- 它**不进模型请求**：provider 侧只取 `name` / `description` / `inputSchema` / `outputSchema`（`adapters/src/model/tool-transform.ts`）。它唯一的消费点是上下文估算 —— `context-usage.ts:317` 把它塞进待估算的文本块。

⇒ **填 `"ocr"` 这类能力键不会编译失败，但与既有惯例不符**：既丢失了给上下文估算用的英文能力描述，也与同仓库其他 tool 的写法不一致。正确做法：**`capability` 写英文散文**（描述这个 tool 能做什么），**能力键另找地方存**（工具名本身就由能力键派生 —— OCR 的键是单段 `ocr`（`ocr-local.md` §3），tool 名也是 `ocr`；点号键如 `doc.parse` → `doc_parse`）。若需要机器可读的能力键，在 `metadata` 里另开字段，**不要占用 `capability`**。

⚠️ **投影 C 要单独展开成一份 spec**（像 `docs/design/v2/tool/<n>-*.md` 那样），逐条对齐 `00-tool-change-chain.md` 的端到端链路（权限 / Hook / Mode / 调度 / I/O adapter / 结果预算与 artifact / session event 与持久化）。本表只是**最低集**，不是完整检查表。

#### ⚠️ 写工作区的能力会触发 dynamic-workflow 的「第一笔写入」

这不是推测，是既有代码的既定行为，能力投影时必须知情：

```
ToolCallStarted 事件
  → workflow-driver-tool-activity.ts:133  isWorkspaceMutatingToolCall(capability)
       判定：readOnly !== true 且 sideEffectScope ∈ { workspace, git, system }
       （缺席范围按「会写」处理 —— 未声明即不可信）
  → handlers.onMutating() → workflow-driver.ts:274  sink.askMutating(instance)
  → 引擎记下 import-cache-closed（见 dynamic-workflow-run-service.test.ts:7210）
```

⇒ **任何声明 `mutating` 且 `sideEffects = "workspace"` 的能力，子代理第一次调它就会关闭 dynamic-workflow 的导入缓存**。OCR 写 sidecar 落在工作区内（`ocr-local.md` §6.3），因此能力键 `ocr` 属于这一类 —— 这**是期望行为**（sidecar 确实改了工作区），但实现时不能把它当成意外：投影时 `metadata.readOnly` / `metadata.sideEffectScope` 必须如实填 `false` / `"workspace"`，不能为了少一次缓存失效而填成 `none`。

⚠️ 连带影响：`isWorldTouchingToolCall`（同文件 `:132`）会把 `workspace` 计入 `worldToolCalls` —— 该计数用于 dynamic-workflow 的并发/席位门（`workflow-driver-concurrency.ts`）。**能力投影后，这个计数会变**，涉及门限的回归测试要一起跑。

⇒ 推论：**纯读的能力**（如 `knowledge_search`）应声明 `readOnly: true` + `sideEffectScope: "none"`，否则会把只读工具算成写操作，白白关掉导入缓存。

**默认开关**

- 能力来源的内置工具：**默认关闭**。理由：内置工具集合膨胀会挤占模型的工具预算；能力要显式启用。
- ⚠️ **启用旗标另起名**，不要复用 `--capability`（§2 已说明它被 `capability-override.ts` 占用，取值形态是 `<能力键>=<模型类型名>`）。建议 `--enable-capability <key>`。
- **非能力来源的内置工具不走这条规则**，其默认策略由其自身 spec 定义，但**必须在本节登记**，保持可发现：

  | 工具 | 默认 | 注册门 | 来源 |
  | --- | --- | --- | --- |
  | `knowledge_search` | **在场即开** | `knowledgeIndexPort` 在场 | [`knowledge-rag.md`](./knowledge-rag.md) §8.2（runtime 子系统，不经本注册表） |

  ⚠️ 工具名一律 **snake_case**；能力来源的用「能力键点号换下划线」（`doc.parse` → `doc_parse`），非能力来源的同样 snake_case。

⚠️ 投影 C 需要读 `docs/design/v2/tool/00-tool-change-chain.md`（CLI AGENTS.md 硬性要求），按端到端链路逐项检查后再实现。

### 4.5 投影共用一份实现

```
        ┌─────────────────────────┐
        │ CapabilityDefinition    │  ← execute() 只写一次
        │   inputSchema/outputSchema│
        └───────────┬─────────────┘
                    │
   ┌────────────────┼────────────────┐
   │                │                │
┌──▼───┐      ┌─────▼─────┐    ┌─────▼─────┐
│ CLI  │      │    MCP    │    │ 内置工具   │
│zcode │      │ stdio srv │    │ core tool │
│ cap  │      │           │    │           │
└──────┘      └───────────┘    └───────────┘
```

三个投影只做**入参适配 / 出参校验 / 权限与错误映射**，不含业务逻辑。

### 4.6 执行链路与事件顺序（owner 图）

AGENTS.md 要求「涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序」。本 spec 的执行链路：

```
   调用方（CLI 进程 / MCP server 进程 / core tool 调度）
      │
      │ 1. 解析入参 → zod 校验（inputSchema）
      ▼
   ┌─────────────────────────────────────────────┐
   │ 投影层（cli.ts / mcp.ts / tool.ts）            │  ← 只做适配与错误映射
   │  owner：各投影自己的进程/会话上下文           │
   └───────────────┬─────────────────────────────┘
                   │ 2. 组装 CapabilityContext
                   │    traceId / workspaceKey / ports / logger
                   ▼
   ┌─────────────────────────────────────────────┐
   │ 能力实现（capabilities/src/capabilities/*）   │  ← owner：业务编排
   │  · 读 context.ports，**不碰 fs / child_process**│
   └───────────────┬─────────────────────────────┘
                   │ 3. 经端口发起 I/O
                   ▼
   ┌─────────────────────────────────────────────┐
   │ 端口实现（adapters/src/ocr/* 等）              │  ← owner：外部 I/O
   │  ExecutionPort → 子进程                       │
   │  FileSystemPort → 原子写 / 临时文件           │
   │  LocalAssetPort → 资产路径（每次调用重读）     │
   └───────────────┬─────────────────────────────┘
                   │ 4. 结果 / 错误回传
                   ▼
   能力实现 → 投影层 → 5. 信封 + 退出码（唯一出口）

事件顺序（单次能力调用，投影无关）：
   解析 → 校验 → 能力执行 →（逐页：渲染 → 预处理 → 识别 → 断言产物）
        → 汇总 → 输出校验（outputSchema）→ 出参校验失败则兜成 internal
        → 投影层写信封 / stderr 一行 → 返回退出码
```

**关键顺序约束**

- **子进程永远在端口后面**（第 3 步），能力实现不直接 spawn。
- **产物断言在「进程退出码 0」之后、「汇总」之前** —— 退出码 0 不等于成功（`ocr-local.md` §2 的 `configs/` 静默失败坑）。
- **输出校验在投影层返回前**（第 5 步），不过则兜成 `internal`。
- **退出码只在投影层产生**；能力实现不调 `process.exit`（CLI AGENTS.md）。

## 5. 状态所有者

| 状态 / 事件流 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 能力定义与注册表 | `apps/zcode-cli/packages/capabilities/src/registry.ts` | 进程内单例，bootstrap 装配时填充 |
| 能力执行上下文 | `apps/zcode-cli/packages/capabilities/src/context.ts` | 组装 traceId / workspaceKey / ports |
| 端口实例（OCR 引擎、资产、检索库） | `apps/zcode-cli/packages/bootstrap/src/app/port-wiring.ts` | 与既有 `workspaceResourceIndexPort` 同处装配 |
| CLI 投影的参数解析与退出码 | `apps/zcode-cli/packages/cli/src/capability-command.ts` | 唯一出口，返回 exit code 给 `run.ts`，不调 `process.exit` |
| MCP 投影的连接与工具注册 | `packages/bootstrap/src/app/`（路线 a）或插件包 + `OFFICIAL_PLUGIN_DEFINITIONS`（路线 b） | 见 §4.3，**待定**；不在业务包内拉起 server |
| 内置工具投影的权限判定 | `apps/zcode-cli/packages/core/src/tool/handlers/` | 复用既有权限层，不自造 |
| **OCR sidecar 的写入** | `apps/zcode-cli/packages/adapters/src/ocr/`（sidecar store） | 原子写；**能力层只发指令，不直接 fs**（见下） |
| **MinerU 的引擎定位 / 档位选择 / 降级 / 产物落盘** | `apps/zcode-cli/packages/adapters/src/local-infra/` | ⚠️ 同上：**adapter 写，能力层只发指令**（[`local-infra.md`](./local-infra.md) §6.1） |
| **OCR sidecar 的读取 + 缓存失效** | `apps/zcode-cli/packages/office-runtime/src/adapters/files.ts` | 只读；`fingerprint` 含 sidecar 大小与 mtime |
| OCR 文本层 sidecar **的格式与落点** | `ocr-local.md` 定义的 `<源文件名>.zcode-ocr.json` | ⚠️ `<源文件名>` **含扩展名**（`扫描件.pdf.zcode-ocr.json`） |
| 本地知识库（分块 / 全文索引） | `knowledge-rag.md` 定义的独立 SQLite | 每 workspace 一个文件；属 runtime 子系统，不经本注册表 |

⚠️ **sidecar 的文件 I/O 不落在能力层**。CLI AGENTS.md「除入口层、基础设施层和 adapter 外，业务模块不得直接调用 `fs`」—— 原子写、临时文件、Windows rename 差异都是基础设施细节。能力层只发「写这个 sidecar」的指令，实际落盘由 `adapters/src/ocr/` 的 sidecar store 经 `FileSystemPort` 完成。

**避免的反模式**

- 不让三个投影各写一份参数校验（都走 `inputSchema`）。
- 不让能力实现自己 new 端口（端口由 bootstrap 注入）。
- 不让 MCP 投影自己实现业务（只转发 `execute`）。
- 不在 CLI 层缓存能力结果（缓存属于能力内部，CLI 只是调用方）。

## 6. 包与目录放置

> ⚠️⚠️ **2026-11-12：包层位已定（路线 a，契约下沉）** —— 见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D8：
> - **契约** → `apps/zcode-cli/packages/contracts/src/capability-blocks/`（⚠️ **不叫 `capabilities`** —— 那个目录已存在，是 provider / model 能力描述的空壳，撞名）；
> - **实现** → `apps/zcode-cli/packages/core/src/capability/`；
> - **装配** → `apps/zcode-cli/packages/bootstrap/src/capability/`。
> ⇒ **下面这份 `packages/capabilities/` 的目录规划作废**（该包**不存在**，见 [`local-infra.md`](./local-infra.md) §13 实测表），保留作历史记录。

```
apps/zcode-cli/packages/capabilities/          ← ⚠️ 作废：不存在
  src/
    contract.ts        # §3 的类型 + 错误码
    registry.ts        # §4.1 注册表
    context.ts         # 上下文组装
    capabilities/      # 各能力的薄实现（编排端口，不直接 I/O）
    projections/
      cli.ts           # 投影 A 的入参/出参适配
      mcp.ts           # 投影 B
      tool.ts          # 投影 C
    index.ts
```

新增端口进 `apps/zcode-cli/packages/contracts/src/interfaces/`（`ocr-engine.port.ts`、`image-preprocess.port.ts`、`local-asset.port.ts`），端口实现进 `apps/zcode-cli/packages/adapters/src/`（`ocr/`、`local-assets/`）。

知识检索的端口（`knowledge-index.port.ts` / 检索源）由 [`knowledge-rag.md`](./knowledge-rag.md) 定义，落在 `contracts` 与 `adapters`，**但不经本注册表**——它是 runtime 子系统，不是「一次实现三投影」的能力。

依赖方向：`capabilities → contracts`（只用端口类型），`adapters → contracts`，`bootstrap → {capabilities, adapters}`。**禁止** `capabilities → adapters`（那是倒挂）和 `contracts → capabilities`。

⚠️ **包层位是待决项，本 spec 不替用户定**。`architecture.md` §1.2/§1.3 的四层模型（`contracts` / `core` / `adapters` / `bootstrap`）里**没有 `capabilities` 这一层**，`architecture.md` §2 的结构里那个 `capabilities/` 指的是 `contracts/src/capabilities/`（现有内容是空壳 `export {}`，注释写着「provider and model capability descriptions」）。因此 `packages/capabilities` 作为独立业务包会撞两处：

1. **撞名**：`packages/contracts/src/capabilities/` 已存在且语义是「provider / model 能力描述」，而本 spec §2 恰恰在强调「两套命名空间，别混」—— 新包名引入了第三套同名概念。
2. **依赖方向**：`architecture.md` §1.3 明写「`core` 只依赖 `contracts`」「`adapters` 只依赖 `contracts`」，禁止 `core` 依赖 `adapters`。但投影 C 要把能力注册成 **core 内置 tool**（§4.4 把权限判定放在 `packages/core/src/tool/handlers/`）→ core 必须拿到能力定义与 `execute` → 出现 `core → capabilities` 这条**四层模型未允许**的编译依赖。

两条合规路线，**选一条写死**（实施前必须定）：

- **(a) 契约下沉**：能力契约（`CapabilityKey` / `CapabilityDefinition` / `CapabilityContext`）放进**已存在的** `packages/contracts/src/capabilities/`，实现放 `packages/core/src/capability/`，三投影装配放 `packages/bootstrap/src/app/`。→ 不新增层，不改架构文档，但 `core` 里多一块能力实现。
- **(b) 保留独立包**：同步更新 `architecture.md` §1.2/§1.3/§2 与 `architecture-policy.yaml` 的层模型，把 `capabilities` 登记为合法层；**并明确「core 不 import capabilities」** —— 能力以 `contracts` 里的 `ToolEntry` 形态由 bootstrap 注册进 core 的 tool registry。

无论选哪条，MCP server 都不能留在业务包内（§4.3）。

⚠️ **新增端口必须同时进两个 barrel**：`packages/contracts/src/interfaces/index.ts` **和** `packages/contracts/src/index.ts`。（现状提醒：`audio.port.ts` / `audio-transcription.port.ts` 未被这两个 barrel 导出 —— 属既有偏差，新端口不要照抄这个漏法。）

⚠️ **新增源码文件必须先做架构登记**。`architecture-policy.yaml` 的 `global.newFilesRequireManagedModule: true` + `violations.mjs` 的 `unmanaged-new-file` 规则要求：**新增 `.ts` 源码必须落在 `managed: true` 的模块里**，否则 `pnpm architecture:check --changed` 直接报违规（当前 `zcode-cli` 模块是 `managed: false`）。两条路：

```
# 路线 1：登记为 managed 模块（需补 module.ts / contract.ts / contract.example.ts / CONTRACT.md）
pnpm architecture:adopt <id> --root apps/zcode-cli/packages/<dir> --layer app

# 路线 2：在 architecture-policy.yaml 的 exceptions 里逐文件登记并写明理由
```

⚠️ `adopt.mjs` 的 `--layer` **默认值是 `adapters`** —— 业务层目录必须**显式**写 `--layer app`，否则会被标成 adapter 层。各 spec 新增目录清单见各自的实施顺序。

## 7. 错误语义与退出码

| 情形 | `CapabilityResult` | CLI 退出码 |
| --- | --- | --- |
| 能力成功 | `ok: true` | `0` |
| `unsupported_input` / `invalid_input` | `ok: false` + error | `1` |
| `unavailable`（依赖缺失） | `ok: false` + error | `1` |
| `not_found` | `ok: false` + error | `1` |
| `permission_denied` | `ok: false` + error | `1` |
| `cancelled` | `ok: false` + error | `130`（与 POSIX SIGINT 惯例一致） |
| `timeout` | `ok: false` + error | `124` |
| `internal`（未预期异常 / schema 校验不过） | `ok: false` + error | `1` |

CLI 投影把 `error` 写 stderr 一行（`--json` 时同时进 stdout 的 JSON 信封），**不打印堆栈**。`--verbose` 时追加 `details`。

⚠️ **对外错误码只有一个闭集**。`error.code` 只允许取上表的 8 个 `CapabilityErrorCode` 值 —— 引擎层 / 资产层的细粒度码**必须归一**，原始码放 `details`：

| 底层码（引擎层 / 资产层） | → 对外 `error.code` | 细粒度信息放哪 |
| --- | --- | --- |
| `engine_unavailable` | `unavailable` | `details.engineCode` + `hint`（安装命令） |
| `engine_not_found` | `invalid_input` | `details.engineCode`（指定的引擎 / **档位不在官方枚举内**） |
| `input_invalid` | `not_found`（文件不存在） / `unsupported_input`（类型不支持） | `details.engineCode` —— ⚠️ **二选一的规则必须写死**，否则实现者各写各的 |
| `artifact_missing` | `internal` | `details.engineCode` —— ⚠️ **退出码 0 但产物缺失 ≠ 成功** |
| `language_missing` | `unavailable` | `details.missingLanguages` + `hint`（`zcode asset install tessdata-zh-en`） |
| 资产 `not_found` / 资产未安装 / 未激活 | `unavailable` | `details.assetCode` + `details.group` |
| `password_protected` | `invalid_input` | `hint`（加密 PDF 的说明） |
| `corrupted` | `invalid_input` | `details.engineCode` / `details.assetCode` |
| `process_failed` | `internal` | `details.engineCode` + stderr 尾 |
| `unsupported_input` | `unsupported_input` | — |
| `timeout` / `cancelled` | 同名 | — |

⚠️ **归一方向是单向的：底层 → 能力码**。不是「CLI 层把能力码映射成资产码」。资产层自己的 `LocalAssetErrorCode`（见 [`model-assets.md`](./model-assets.md) §12）**只存在于 `zcode asset` 命令面**，不进能力信封。

⚠️ **明确的例外**：`zcode standards validate` 的退出码是 `0 / 1 / 2`（`2` = 文件读不到 / 非法 JSON），**不与本表同源**。该命令面**不注册**为能力键（见 §10 与 §11）—— 这是一个有意的例外，不是遗漏。

MCP 投影把 `ok: false` 映射成 MCP tool error（`isError: true` + 结构化内容），**不抛协议级异常**——协议级异常会让整个 server 掉线，掩盖真实错误。

内置工具投影把失败映射成 tool result 的错误段，让模型能读到 `code` 和 `hint`。

## 8. 输出信封

⚠️ **2026-11-12 修订**：CLI 面的命令不再是 `zcode cap run`（见 §4.2 横幅），而是**族命令组积木**（`zcode ocr parse` 等，见 [`capability-cli-blocks.md`](./capability-cli-blocks.md)）。**信封形状沿用本节**，只有 `key` 的取值按投影不同（见下）。

`--json` 时 stdout 是**一个** JSON 对象：

```json
{
  "version": 1,
  "key": "ocr",
  "ok": true,
  "output": { "…": "能力自己的输出" },
  "metrics": { "durationMs": 1234, "items": 12 }
}
```

⚠️ **`key` 的取值分投影**：

| 投影 | `key` 取值 | 说明 |
| --- | --- | --- |
| **CLI（族命令组积木）** | **积木 id**（`ocr.inspect` / `ocr.parse` / …，闭集见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §5.1） | 业务主接入面；一个能力键可对应多个积木 |
| **MCP / 内置工具** | **能力键**（`ocr` / `doc.parse` / …） | 注册表里的键；跨投影通用 |

失败时：

```json
{ "version": 1, "key": "ocr", "ok": false, "error": { "code": "unavailable", "message": "…", "hint": "…" } }
```

⚠️ **`version` 是对外契约的一部分**。投影 A 是业务客户端的主接入面（§4.2），业务方会写代码解析这个信封 → 字段增删、退出码语义变化都要**递增 `version`** 并同步业务方，不能悄悄改。

`--output-format stream-json` 时按行吐 NDJSON：`{"type":"result", …}`。**流式进度**（如 OCR 逐页）不进信封，由能力自己通过 `context.onProgress` 回调吐，投影层决定渲染方式。

## 9. 验收

⚠️ **测试入口按目标包选，不要默认用 `pnpm test:engineering`**。根 `vitest.config.ts` 的 `engineering` project 的 `include` 是 `scripts/engineering-test-files.json` 的**显式清单**（158 条），其中 **`apps/zcode-cli/**` 与 `packages/shared/**` 各 0 条** → 对这些包跑 `pnpm test:engineering <file>` 会得到「No test files found」**且不报错**，验收表形同虚设。

| 目标包 | 正确入口 | 备注 |
| --- | --- | --- |
| `@zcode/core` / `@zcode/adapters` / `@zcode/contracts` / `@zcode/bootstrap` | `pnpm --dir apps/zcode-cli --filter <pkg> test`（= `vitest tests`，跑整个 `tests/` 目录） | 新测试文件放进包的 `tests/` 即可被发现 |
| `@zcode/cli` | `pnpm --dir apps/zcode-cli --filter @zcode/cli test`（= `node --test` + **package.json 里显式列出的文件**） | ⚠️ 新增测试**必须**把文件加进 `packages/cli/package.json` 的 `scripts.test` 列表，否则不会被跑 |
| `packages/shared` | ⚠️ **当前无任何入口** —— 该包没有 `test` 脚本，也不在 engineering 清单里 | 新增测试要么登记进 `scripts/engineering-test-files.json`，要么给该包补 `test` 脚本。**不要**假设能跑起来 |
| 根工程门禁 | `pnpm test:engineering <file>`（**仅限清单内文件**） | 确实要进根门禁的，才登记进 `scripts/engineering-test-files.json` |

工程测试覆盖：

| 场景 | 断言 |
| --- | --- |
| 注册表 | 重复键注册抛错；`list()` 返回全部；`get()` 未知键返回 `undefined` |
| 契约 | `execute` 返回的 `output` 过 `outputSchema`；不过则兜成 `internal` |
| CLI 投影 | ⛔ `cap list` / `cap describe` / `cap run` **不实现**（§4.2 横幅）⇒ 改为验收**族命令组积木**的 stdout 与退出码（落点见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §10.4）；⚠️ **CLI 包的测试必须显式登记进 `packages/cli/package.json` 的 `scripts.test` 清单**才会被跑 |
| 退出码 | 逐条对上 §7 的表（用假能力注入，不连真引擎） |
| 三投影同源 | 同一能力经 CLI / MCP / 内置工具调用，`inputSchema` 与实际收到的入参一致 |
| 权限 | `mutating: true` 的能力经内置工具投影时被权限层拦下 |

**不测**：真实 tesseract —— 那是 `ocr-local.md` 的验收。

## 10. 与既有子命令的关系

| 既有命令 | 与本 spec 的关系 | 本期动作 |
| --- | --- | --- |
| `zcode recognize` | 视觉识别能力；已有独立模型优先链 + 接地不变量 | **不动**。未来可作为 `vision.describe` 能力的薄封装 |
| `zcode memo validate` | 规则校验能力（memo-v30 的实例） | **不动**。[`standard-rule-engine.md`](./standard-rule-engine.md) §7 把它收敛成 `zcode standards validate --standard memo-v30` 的**薄封装**（行为、退出码、输出格式一字不变） |
| `zcode plugins` / `zcode skills` / `zcode usage` | 管理类命令，不是能力 | 不动 |
| `zcode doctor` | 运行时自检 | 不动（⚠️ §4.2 的 `cap list` 已作废，不作为它的补充） |

## 11. 实施顺序与未决问题

**实施顺序**（每步一个提交）：

0. **架构登记**（前置，见 §6）：把新增源码目录登记为 managed 模块，或在 `architecture-policy.yaml` 的 `exceptions` 里逐文件登记。**不做这一步，第 1 步起的每个新增 `.ts` 都会让 `pnpm architecture:check --changed` 报 `unmanaged-new-file`**。
1. `capabilities` 包的 contract + registry + 假能力（测试用）。包层位按 §6 的路线 (a) 或 (b) —— **先定路线再动手**。
2. CLI 投影 `zcode cap`（含 `arguments.ts` 旗标注册 + `run.ts` 的 `case "cap"` + help 文案，§4.2 的四件套）。
3. MCP 投影（stdio server）—— 落点按 §4.3 的路线 (a) 或 (b)。
4. 内置工具投影（先读 `00-tool-change-chain.md` 并另写一份投影 spec，见 §4.4）。
5. 接入真实能力：**OCR**。（知识检索**不在**本序列里——它走 [`knowledge-rag.md`](./knowledge-rag.md) §15 的实施顺序。**规则引擎也不在本序列里**——它不注册能力键，见 §10 与 [`standard-rule-engine.md`](./standard-rule-engine.md) §7。）

**未决问题**

1. ~~**能力实现放哪一层？**~~ → ⚠️ **2026-11-12 已定**：**路线 (a) 契约下沉**（契约 `contracts/src/capability-blocks/` → 实现 `core/src/capability/` → 装配 `bootstrap/`），见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D8。⇒ **不新建 `packages/capabilities`**（该包不存在，且会撞 `contracts/src/capabilities/` 的名）。
2. **MCP server 落在哪？** §4.3 的 (a) `packages/bootstrap/src/app/` 还是 (b) 插件包 + `OFFICIAL_PLUGIN_DEFINITIONS`？
3. **`MODEL_CAPABILITIES` 是否扩到 `pdf` / `video`？** provider 的 `inputFormat` 已有 **5 个位**（`packages/provider/src/resolver.ts:84-89`：`supportsText` / `supportsImage` / `supportsVideo` / **`supportsAudio`** / `supportsPdf`），`modelSupportsCapability` 加两个 case 即可。⚠️ 但 **provider 侧已经有 `supportsAudio`**（`packages/provider/src/config/model-config.ts:117` 定义、`packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts:65` 已在消费）—— 缺的**不是** provider 侧的能力位，而是 **CLI 内容块与转写实现**：`ModelMessageContentBlock` **没有 audio 分支**（`apps/zcode-cli/packages/contracts/src/model/index.ts:408-415`），adapters 里也没有转写实现 → 「把音频喂给模型」这条路暂时不通，音频只能走「转写 → 文本」。扩展能力位属独立 spec，本期不动。
4. **内置工具默认关还是默认开？** 本 spec 取「默认关」，需用户确认。旗标名建议 `--enable-capability`（**不可复用 `--capability`**，§2）。
5. **能力注册表是否允许插件注册？** v1 只允许内置能力；插件自带 MCP server（既有形态）已经覆盖这个需求。
6. ~~**`zcode cap run --param` 是否够用？**~~ → ⚠️ **2026-11-12 作废**：`zcode cap run` 整体不实现（§4.2 横幅）⇒ 参数怎么给由族命令组各自定义（[`capability-cli-blocks.md`](./capability-cli-blocks.md) §4.2），**不做批量旗标**（D1）。
7. **规则引擎要不要注册成 `standards.validate` 能力键？** 本 spec 取**不注册**（`zcode standards validate` 保持独立命令面，退出码 `0/1/2` 作为明确例外写进 §7；理由见 [`standard-rule-engine.md`](./standard-rule-engine.md) §1 与 §7.1）。若将来要注册，三件事必须**同时**做：IO 错误改 `1`、补 `130`/`124`、删掉 `zcode standards validate` —— 只做一件就是对业务方的破坏性变更。
8. **投影 C 何时做？** 它的前置是另写一份投影 spec 对齐 tool 变更链，不能在能力层做一半就上。⚠️ **2026-11-12：暂缓**（用户未定，见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §12 O4）—— CLI 积木面先行。
