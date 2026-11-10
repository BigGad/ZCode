# 能力按需供给（Capability Provisioning）

Status: **规格草案**（2026-11-11）：决策已定，分三步实施；**第 1 步待实现**。

### 实施状态（2026-11-11）

| 落点 | 路径 | 状态 |
| --- | --- | --- |
| 本 spec | `apps/zcode-cli/docs/design/v2/capability-provisioning.md` | ✅ 已写（草案） |
| 供给层实现 | `apps/zcode-cli/packages/core/src/runtime/helpers/capability-provisioning/` | ❌ 未写（第 1 步） |
| `LocalInfraPort` 的装配 | `packages/bootstrap/src/app/port-wiring.ts` | ❌ 未装（v1 只在独立的 `zcode-infr-manage` 入口里用） |
| 降级策略配置键 | `adapters/src/config/schema.ts` 的 `ocrConfigSchema` | ❌ 未加 `degradation` |
| 产物 variant kind | `contracts` 的 `WorkspaceResourceVariant.kind` | ❌ 未加 `ocr` |

> ⚠️ **本 spec 是新的一层，不是给已有层加分支。** 现有四层各管一件事，缺的正是「就位」这一环 —— 现在整条链的能力供给是「**不可用就报错**」（`engine_unavailable` / `transcription_engine_unavailable`），而产品要的是「**不可用就建起来**」。

## 1. 目的与范围

**一句话：让 ZCode 在任务需要时，自己把底层能力（当前是本地 OCR）拉起来 / 备好，用户不感知命令。**

- **触发点**：任务加载 / 附件解析阶段 —— 不是用户手动敲 `zcode-infr-manage`。
- **供给对象**：**能力可用性**，不是「模型环境」（§2 的 D1）。
- **v1（第 1 步）范围**：本地 MinerU **已就位**时自动用；不就位时给**确定的下一步**（装什么 / 下什么）。
- **v1 不做**：自动安装引擎二进制；自动下载权重（第 2 步）；退云端（第 3 步，默认关）。

**v1 不适用**

- 不做本地 embedding / 本地 LLM 服务（走 provider 与 model selection）。
- 不做常驻守护进程 —— 进程按需拉起、用完即退（与 [`local-infra.md`](./local-infra.md) v1 一致）。
- 不实现 [`capability-registry.md`](./capability-registry.md) 的三投影（整块未实现）。本 spec 定义的是它**上面**的一层，投影落地时直接挂上去。
- 不做音频转写的供给（[`audio-input.md`](./audio-input.md) 的 whisper 路线另议）—— ⚠️ 但**判定表与策略位按可扩展设计**（§6.3）。

## 2. 决策（用户已定）

| 编号 | 决策 |
| --- | --- |
| D1 | 供给是**独立的一层**，不是给已有层加分支。 |
| D2 | **就绪状态是可查询的**：`doctor` 的报告从「一次性体检输出」升级为「运行时可查的状态」。 |
| D3 | **降级是判定输出的一个字段**，不是代码分支。v1 取值集合只有 `error`；扩展是**加枚举成员**，不改契约形状 ⇒ 对外契约版本不递增。 |
| D4 | 能力可用性是**链**，不是布尔：每项带状态 + 原因，链的形状要留得住「以后可能都需要」。 |
| D5 | **引擎二进制不由 ZCode 安装**（第三方发行物：跨平台矩阵、权限、装坏了不可回滚）；**资产（权重 / 语言包）可以由 ZCode 备**（未来）。 |
| D6 | 将来退到云端**必须显式授权** —— 文档会离开机器，这与 [`local-infra.md`](./local-infra.md)「绝不构造 `--remote` / `--api-key`」是同一条红线，只是发生在 provider 层。 |
| D7 | **判定规则不由模型决定** —— 沿用现有纪律：策略判定归 `resource-policy`，不让模型自己声明「我需要 OCR」。 |
| D8 | **ZCode 自动起 OCR**：用户不感知命令，本地引擎由 ZCode 自己拉起。 |

⚠️ **D3 与 D4 是为了让「后期可能都需要」变便宜。** 如果 v1 把「本地 / 云端」写成两个并列分支、或者把「不降级」写成「代码里压根没有那条路」，后期加云端退路就是改协议形状（对外契约要版本递增）；写成枚举成员则只是加一个值。

## 3. 概念模型

四个概念，别混：

| 概念 | 含义 | 现有对应 |
| --- | --- | --- |
| **能力（capability）** | 一个可被任务消费的处理能力（当前：`ocr`） | `capability-registry.md` §3 的能力键 |
| **就绪状态（readiness）** | 该能力**此刻在这台机器上能不能用**，以及不能用的原因 | ⚠️ `local-infra.md` §5.4 的三层就绪，目前**只存在于 `doctor` 的输出里** |
| **供给（provision）** | 把「不就位」变成「就位」的动作 | ❌ **不存在** —— 本 spec 新增 |
| **降级策略（degradation）** | 供给失败 / 能力不可用时怎么办 | ❌ 不存在 —— 本 spec 定义枚举 |

⚠️ **就绪与产物是两回事**：`readiness` 说「能不能用」，产物说「做出了什么」。**就绪状态不得被写进产物或 sidecar** —— 同一份产物在不同时刻的就绪状态可能不同。

⚠️ **就绪状态不得跨进程缓存**（沿用 `local-infra.md` §6.1「引擎定位每次现查，环境会变」）。可在**单次任务内**缓存，避免同一轮里重复探测。

⚠️ **名字撞车提醒**：`zcode doctor`（`cli/src/run.ts:251`）查的是 **CLI 自身的运行时信息**（版本 / 平台 / SEA / 打包形态），与 `zcode-infr-manage doctor`（**引擎环境体检**，local-infra §5.4）**是两个不同的命令**。本 spec 的「就绪状态」来自后者 —— 别把两者混成一件事，也别让本层复用 `zcode doctor` 的名字。

## 4. 三层就绪与「不就位」的两种性质

沿用 [`local-infra.md`](./local-infra.md) §5.4 已实测的三层就绪：

| 层 | 判据 | 不就位时的性质 | 处置 |
| --- | --- | --- | --- |
| ① 可执行 | 找到 `mineru-kit`（干活）与 `mineru`（版本检查） | **不可用** | 给装法（D5：ZCode 不装第三方可执行文件） |
| ② 依赖齐 | `mineru version --json` 能跑 | **不可用** | 同上 |
| ③ 模型就绪 | 目标档位的模型仓库已下载 | **未就位** | ZCode 可以自己备（第 2 步，依赖资产层） |

⇒ **「不可用」与「未就位」必须分开**，这是本 spec 最核心的一条分界：

- **不可用** = ZCode 没资格自作主张（要往用户机器上装别人的可执行文件）→ 沿用既有报错路径，但要把「装什么、怎么装」说死；
- **未就位** = ZCode 托管资产的本分（`model-assets.md` §1「模型与语言包由 ZCode 托管」）→ 由 ZCode 备（第 2 步）。

⚠️ **v1 只做到「不可用时把下一步说清楚」**：第 ③ 层虽然已能判定，但自动下载被 asset 组的 7 条待决卡住（最关键是目录地址只有占位 URL —— [`local-infra.md`](./local-infra.md) §7.3），所以 v1 给的是**确切命令**（`zcode-infr-manage models download --tier <t>`），不是自动下载。

## 5. 三步路线

依赖递增，每步都能独立交付、独立验证。

| 步 | 交付 | 依赖 | 兑现的产品承诺 |
| --- | --- | --- | --- |
| **1** | 就绪状态**可查询** + 附件链自动判定 + **本地已就位则自动用** | 无（复用现有 `LocalInfraPort` 与已实现的 `zcode-infr-manage models download`） | D8「ZCode 自己起 OCR，用户不感知命令」 |
| **2** | 未就位时**自动备资产** | asset 组的 7 条待决解掉（[`local-infra.md`](./local-infra.md) §7.3） | 「开箱可用」真正兑现 |
| **3** | 本地失败**退云端** | 上面 + provider 选择 + 授权交互 | 体验连续（**默认关**，见 D6） |

⚠️ **第 1 步不需要等资产层**：用户自己跑一次 `zcode-infr-manage models download --tier basic`（这条命令上一轮已实现并实测过）就满足第 ③ 层，ZCode 随即能用。这是「按需供给」里**不依赖任何未决决策**的那一段，也是最该先落地的一段。

⚠️ **第 1 步与第 2 步的差别只在「谁来按下下载键」**：ZCode 代按（自动）还是用户自己按（给命令）。判定与就绪状态的代码**完全共用**，所以第 1 步的实现不会因为第 2 步延期而返工。

### 5.1 第 1 步的用户可见行为

| 场景 | ZCode 的行为 |
| --- | --- |
| 附件是 PDF，模型**能看图**（`supportsImage === true`） | 走现有的页图渲染路线（**不变**） |
| 附件是 PDF，模型**原生支持 PDF**（`supportsPdf === true`） | 走现有的 file block 路线（**不变**） |
| 附件是 PDF，模型**既不支持 PDF 也不支持图片**，本地 MinerU **已就位** | **自动**调本地 MinerU，把 markdown 投影进 prompt（**新**） |
| 同上，但本地**不就位** | 明确报错：缺哪一层 + **确切的下一步命令**（装 mineru-kit / 下 basic 档模型），不静默失败 |
| 附件是普通文本 / 纯文本文件 | 走现有路线（**不变**） |

⚠️ **「本地已就位」的判定要分层给**：第 ① ② 层不就位 ⇒ 装法；第 ③ 层不就位 ⇒ 下载命令。两种「不就位」给出的下一步**不同**，不能合并成一句「请先安装 MinerU」。

## 6. 降级策略（枚举）

D3 的落地形状。**判定规则的输出带这个字段，能力执行时按它决定失败形态**。

```ts
/** 能力不可用 / 供给失败时的降级策略。 */
export type DegradationPolicy =
  /** 明确失败：把不就位的原因与确定的下一步告诉用户，不静默换路。 */
  | "error"
  /** 退到云端 provider —— ⚠️ **文档会离开机器**，必须经显式授权（D6）。 */
  | "cloud";
```

⚠️ **v1 只实现 `error`**。`cloud` 是枚举里的**预留成员**，不是实现 —— 预留它是为了让契约形状一次定死（§2 的 D3）。

⚠️ **「不降级」必须表达成「策略取值 = error」，不能表达成「代码里没有那条路」** —— 否则后期加云端退路就要改协议形状（对外契约版本递增）。

⚠️ **默认策略来自配置，不是硬编码**：判定规则表读用户策略；用户没配 ⇒ `error`。这把「暂时不退」变成**一个可配置项**，而不是一条产品禁令 —— 与用户「后期成熟后可能都需要」的判断一致。

## 7. 判定规则与触发点

### 7.1 触发点

**判定发生在附件解析阶段**（任务加载时），不发生在能力被调用的那一刻 —— 附件类型在解析前就已知，而「需不需要 OCR」这件事必须在**决定怎么把附件喂给模型之前**答完。

具体落点：`core/src/runtime/helpers/attachments.ts:99` 的 `resolveTurnAttachments` → `resolveTurnAttachmentContent`（:119）→ 按类型分派到 `resolveLocalMediaAttachment`（:209-214）/ `resolveInlineMediaAttachment`（:241）→ PDF 分支 `resolveLocalPdfAttachment`（`local-media-resolver.ts:91`）。

⚠️ **判定不交给模型**（D7）：模型自己说「我需要 OCR」是不可靠的（漏声明 = 静默不生效），且会让同一份附件在不同轮次走不同路径。判定规则表是**静态的、可测的**。

⚠️ **模型能力位在解析时已知**：`turn.ts:632-650` 已经在传 `modelInputFormat: (submissionModel ?? admittedModel)?.properties.inputFormat` ⇒ **判定不需要额外取模型信息**，这是把判定放在解析阶段而不是调用阶段的前提。

### 7.2 规则表

输入：附件类型 + 模型能力位 + 本机就绪状态 + 用户策略。
输出：**处理路线** + 降级策略 + 理由。

⚠️ **模型能力位是两个独立标志，不是一个「有没有视觉」**：`ModelInputFormat` 是 `{ supportsText?, supportsImage?, supportsVideo?, supportsAudio?, supportsPdf? }`（稀疏，`packages/shared/src/model-config.ts:51`）。⇒ **PDF 原生支持（`supportsPdf`）与看图能力（`supportsImage`）是两条不同的路**，规则表必须分开判。

| # | 附件 | 模型能力位 | 本机就绪 | 路线 | 降级策略 |
| --- | --- | --- | --- | --- | --- |
| 1 | 文本 / 纯文本文件 | 任意 | 任意 | 现有文本路线（不变） | — |
| 2 | 图片 | `supportsImage ≠ false` | 任意 | 现有图片路线（不变） | — |
| 3 | 图片 | `supportsImage === false` | 任意 | 现有**能力模型描述**路线（不变，`capability-image-description.ts`） | — |
| 4 | PDF | `supportsImage === true` | 任意 | 现有**页图渲染**路线（不变，`attachment-pdf-pages.ts`） | — |
| 5 | PDF | `supportsImage !== true` 且 `supportsPdf === true` | 任意 | 现有 **file block** 路线（不变） | — |
| 6 | PDF | `supportsImage === false` 且 `supportsPdf === false` | **已就位** | **本地 MinerU**（本 spec 新增） | `error` |
| 7 | PDF | 同上 | 不可用（第 ①② 层） | **明确报错** + 装法 | `error` |
| 8 | PDF | 同上 | 未就位（第 ③ 层） | **明确报错** + 下载命令 | `error` |
| 9 | PDF | 同上 | 就绪但**本次调用失败** | 明确报错（引擎原因），**不重跑、不换路** | `error`（第 3 步才可能 `cloud`） |
| 10 | PDF | 能力位**未知**（`undefined`） | 任意 | 维持现状（**不委派**） | — |

⚠️ **第 6 行的触发条件为什么是两个 `=== false`**：

- `supportsImage === false` ⇒ 页图渲染路线不可用（页图本质是 image block，见 `attachment-pdf-pages.ts:66-71`）；
- `supportsPdf === false` ⇒ file block 路线也不可用（会在请求投影阶段被换成 omitted-media 文本，见 `media-capability.ts:30`）；
- **两个都不可用时，本地 OCR 是唯一能在不把文档送出机器的前提下拿到文字的路。**

⚠️ **触发条件全部收紧，与既有纪律一致**：`capability-image-description.ts:7-9` 写明「模型能力必须**显式**为 `supportsImage === false`（`undefined` 是未知，不委派）」；页图渲染门槛则是 `supportsImage === true`（`attachment-pdf-pages.ts:69-71`）。⇒ **能力位是 `undefined` 时一律维持现状（第 10 行），不委派** —— 未知不等于拒绝。

⚠️ **第 4 / 5 行的优先级沿用现有实现**：现有代码先试页图渲染（`local-media-resolver.ts:91` 的 PDF 分支 → `attachment-pdf-local-render.ts:47`），渲染不可用才回落 file block（`local-media-resolver.ts:137-167`）。本 spec **不改这个顺序**，只在两条都不通时插入第 6 行。

⚠️ **「扫描件 PDF」的判定**：**能不能区分扫描件与电子版 PDF，不在 v1 的判定范围** —— 区分需要先解析才知道（鸡生蛋）。v1 的判据是「模型既不支持 PDF 也不支持图片」+「附件是 PDF」，路线选定后由引擎自己判断该 PDF 有没有文本层。⚠️ 这意味着**电子版 PDF 在这类模型下也会走 MinerU**（比 file block 慢，但结果可用）。列为 §12 的 O1。

⚠️ **规则表是数据，不是代码分支**：判定结果要能被人读懂（「为什么这个文件走了本地 OCR」），所以规则表要能被序列化 / 被测试逐条覆盖。

### 7.3 判定结果的可解释性

判定结果必须能回答两个问题（给用户看，也给日志看）：

1. **为什么走这条路**（命中了规则表的哪一行）；
2. **为什么不走另一条路**（例如「模型有视觉能力，所以走页图渲染而不是本地 OCR」）。

⚠️ 这不是调试信息，是**用户可见的一行** —— 「用本地引擎解析（当前模型不支持图片）」这种话术要能说清，否则用户会以为 ZCode 随机换了条路。

## 8. 契约与落点

### 8.1 命名边界

| 概念 | 归谁 | 本层叫什么 |
| --- | --- | --- |
| 能力键 `ocr`、能力实现、输出信封 | `capability-registry.md`（整块未实现） | —— |
| **就绪状态**（能不能用） | **本层** | `readiness` |
| **供给**（把不就位变成就位） | **本层** | `provisioning` |
| 引擎定位 / 档位 / 降级 / 产物落盘 | `local-infra` 实现模块 | —— |

⚠️ **本层不叫「capability」**（O5 定案）：能力键是「这件事能做什么」，本层是「这件事此刻能不能做」。混用会让 `capability` 一词二义 —— `model-assets.md` §2 已经为「模型 / 资产」做过一次同类拆分，本层沿用同一纪律。

### 8.2 落点

| 落点 | 路径 | 说明 |
| --- | --- | --- |
| 判定 + 供给 helper | `apps/zcode-cli/packages/core/src/runtime/helpers/capability-provisioning/` | 与 `resource-policy/` 同级 |
| 规则表 | 同上（纯 TS 静态表，每行带 id） | 逐行可测、可解释 |
| 降级策略配置 | 机器级配置 `ocr.*` 段：`adapters/src/config/schema.ts:52` 的 `ocrConfigSchema`（现有 `mineruPath` / `mineruProxy` / `enginePath` / `popplerPath`） | 与就绪同域（机器级，非 workspace 级）；**新增 `degradation` 键** |
| 引擎调用 | 经 `LocalInfraPort`（**不 spawn 子进程**） | 沿用「子进程永远在端口后面」 |

⚠️ **不并进 `resource-policy`** —— 三条理由（均为核查结论）：

1. **作用域不同**：`resource-policy` 是 **workspace 级 YAML**（`${workspaceRoot}/.zcode/resource-policy.yaml`，`resource-policy/parser.ts:120`），而就绪状态是**机器级**的；
2. **schema 会冲突**：`resource-policy` 是 `version: z.literal(1)` 的严格 schema（`parser.ts:41`），塞进能力供给策略要升版本；
3. ⚠️ **它当前没有生产调用方** —— `loadResourcePolicy` / `resolvePolicyForEntry` / `parseResourcePolicy` 只在 `packages/core/tests/resource-policy.test.ts` 里被用（`resolveFrameSamplingPolicy` 这个名字**并不存在**，实际是 `resolvePolicyForEntry`）。

⇒ 但**沿用它的形状**（`default` + `byTag`）与它的纪律（策略是数据、判定归一个 owner），将来两者要合并时形状不用改。

### 8.3 契约改动（v1）

⚠️ **v1 不改 `LocalInfraPort`** —— 就绪状态直接由 `doctor()` 的报告**投影**而来：`doctor` 已经含三层信息（`engines[].available` = ①、`versionToolAvailable` + `version` = ②、`models[].status` + `downloadCommand` = ③）。理由：不为性能提前拆契约；探测成本在**任务内缓存**后只付一次。

| 改动 | 落点 | 形状 |
| --- | --- | --- |
| **新增 runtime 依赖** | `core/src/runtime/types.ts:347` 的 `AgentRuntimeDeps` | `localInfraPort?: LocalInfraPort` |
| **新增装配** | `packages/bootstrap/src/app/port-wiring.ts:69` 的 `wirePorts` | `createLocalInfraPort({ execution: executionPort, fileSystem: fileSystemPort, config: { mineruPath, mineruProxy }, pdf: pdfDocumentPort })` |
| **附件解析传参** | `core/src/runtime/methods/turn.ts:632-650` 的 `resolveTurnAttachments` | 新增 `localInfra` 选项（`modelInputFormat` 已在传） |
| **PDF 分支** | `core/src/runtime/helpers/local-media-resolver.ts:91` 的 `resolveLocalPdfAttachment` | 在「页图渲染不可用」与「回落 file block」之间插入本地 OCR 分支 |
| **配置键** | `adapters/src/config/schema.ts:52` 的 `ocrConfigSchema` | 新增 `degradation: z.enum(["error", "cloud"]).optional()`（默认 `error`）—— ⚠️ `cloud` 在 v1 **未实现**，配了要明确报错（验收 A7） |
| **产物登记** | `contracts` 的 `WorkspaceResourceVariant.kind`（现为 `original \| transcript \| frame \| thumbnail \| waveform` 闭集） | ⚠️ **建议新增 `ocr` kind**（对外契约变更，见 §11） |

⚠️ **产物落盘位置必须覆盖**：local-infra 默认落 `<源文件目录>/<源文件名>.mineru/`（§5.5），那是**用户文件旁** —— 附件解析发生在会话里，往那儿写会污染用户目录。⇒ **供给层必须显式传 `outputDir`** 到 workspace 内的 artifact 目录（与附件物化产物同处）。这与 local-infra §6.1「调用方只提供 `outputDir`」一致，不越权。

⚠️ **v1 只支持本地路径 PDF**：inline PDF（粘贴 / data URL）要先经 `artifactStore.ensureMediaAttachmentPath` 物化出可解析路径（现成做法见 `inline-media-resolver.ts:252`），而 inline 的产物落点还要另定 ⇒ v1 不做，列为 §12 的 O7。

### 8.4 判定结果的可解释输出

判定与供给的结果要能产出一行用户可见的话术（§7.3），形状：

```ts
/** 判定结果 —— 规则表命中的那一行 + 为什么。 */
export interface ProvisioningDecision {
  /** 命中的规则 id（§7.2 的行号），便于逐行测试与用户答疑。 */
  readonly ruleId: string;
  /** 路线：本地引擎 / 现有路线 / 报错。 */
  readonly route: "local-engine" | "existing" | "error";
  /** 降级策略（D3）。v1 只有 `error`。 */
  readonly degradation: DegradationPolicy;
  /** 就绪状态（仅本地路线有意义）。 */
  readonly readiness?: LocalReadinessProjection;
  /** 人话理由（一行）。 */
  readonly reason: string;
}
```

## 9. 状态所有者与事件顺序

### 9.1 状态所有者

| 状态 / 事件流 | 唯一所有者 | 备注 |
| --- | --- | --- |
| **就绪状态**（能不能用） | 本层（`capability-provisioning/`） | 从 `doctor()` 报告投影；**任务内缓存，跨进程不缓存** |
| **本次任务的供给决定**（走哪条路） | 本层 | 判定归一个 owner，不散落 |
| 引擎定位 / 档位 / 降级 / 产物落盘 | `local-infra` 实现模块 | 已有（local-infra §6.1） |
| **产物最终落盘位置** | `local-infra` 实现模块（adapter 写） | 调用方只提供 `outputDir`（§8.3） |
| 附件 → content block 的投影 | `core/src/runtime/helpers/conversation.ts:113` | 唯一展开点，不新增投影点 |
| 附件产物登记到资源索引 | `core/src/runtime/helpers/attachment-resource-index.ts:35` | 复用 `upsertAttachmentToResourceIndex` + `addVariant` |
| 降级策略的**取值** | 用户配置（`ocr.*`） | 默认 `error`（§6） |

### 9.2 事件顺序（单次附件解析）

```
   turn 方法                      供给层（core helper）        local-infra 端口      mineru-kit
      │                                │                          │                  │
      │ resolveTurnAttachments(...)     │                          │                  │
      ├───────────────────────────────>│                          │                  │
      │                                │ ① 判附件类型 + 模型能力位  │                  │
      │                                │   → 命中规则表第 N 行      │                  │
      │                                │   （命中本地路线才继续）    │                  │
      │                                │                          │                  │
      │                                │ ② 查就绪（任务内缓存）     │                  │
      │                                │   doctor() ─────────────> │ ── hardware ────>│
      │                                │   <── 三层就绪报告 ───────┤ <── models show ─┤
      │                                │                          │                  │
      │                                │   ┌─ 不就位 → 报错 + 下一步 │                  │
      │                                │   └─ 就位   → ③ 调引擎     │                  │
      │                                │      parse(path, tier) ─>│ ── parse ───────>│
      │                                │      <── {ok, output} ───┤ <── exit code ───┤
      │                                │ ④ 产物落在 workspace artifact 目录              │
      │                                │   登记资源索引 variant=ocr                      │
      │ <── ResolvedTurnAttachment（text block：markdown）──┤        │                  │
      │                                │                          │                  │
      │ ⑤ buildUserContentFromTurn → blocks.push(...)（既有展开点）                   │
```

⚠️ **第 ② 步的探测有成本**（`doctor` 会 spawn `hardware detect` 与 `models show`）⇒ 任务内缓存是硬要求；跨任务不缓存（环境会变，沿用 local-infra §6.1）。

⚠️ **第 ③ 步只 spawn 一次引擎**（local-infra §6.2 的硬要求）；产物断言失败 ⇒ 失败，**不换档重跑**。

⚠️ **第 ⑤ 步不新增投影点**：产物走既有的 `contentBlocks` / `contentBlock` 展开（`conversation.ts:113`），与图片描述那条路（`capability-image-description.ts:31` 把 image block 换成 text block）**同形** —— 都是「把模型吃不了的东西换成文字」。

## 10. 验收场景

沿用仓库约定（AGENTS.md）：**App 业务单测已退役**；CLI 侧保留各自包的回归测试入口，不默认全量。测试入口以目标包 `package.json` 与实际测试文件为准。

| 编号 | 场景 | 断言 | 落点 |
| --- | --- | --- | --- |
| A1 | 就绪状态可查 | 引擎缺失时返回「不可用 + 装法」；就位时返回三层全绿 | adapters |
| A2 | 附件是 PDF、模型无视觉能力、本地已就位 | **自动**调本地引擎，markdown 投影进 prompt | core（附件解析） |
| A3 | 同上但本地不可用（缺引擎） | 报错含**确切安装命令**，不静默失败、不静默换路 | core + adapters |
| A4 | 同上但模型未就位（缺权重） | 报错含**确切下载命令**（`models download --tier <t>`） | core + adapters |
| A5 | 同上但模型**有**视觉能力 | 走**现有页图渲染路线**（行为不变） | core（回归） |
| A6 | 引擎调用失败（退出码非 0） | 报错带引擎 stderr 尾部；**不自动换档重跑**、**不静默退云端** | adapters |
| A7 | 降级策略默认取值 | 未配置 ⇒ `error`；配置为 `cloud` 时 v1 **明确拒绝**（未实现）而不是假装成功 | contracts + core |
| A8 | 判定可解释 | 判定结果带命中的规则号与理由，能回答「为什么走本地 OCR」 | core |

⚠️ **A7 的形状很关键**：v1 不实现 `cloud`，但策略取值被配置成 `cloud` 时**必须明确报错**（"该策略尚未支持"），不能悄悄按 `error` 执行 —— 悄悄降级会让用户以为还在本地跑。

⚠️ **A2 / A5 是回归对**：A5 断的是「有视觉能力时行为不变」。这条要能测，否则新增的本地 OCR 分支很容易把现有的页图渲染路线抢走（默认走本地 = 慢 + 装依赖，是**退化**而不是优化）。

## 11. 与其它 spec 的关系与同步清单

| spec | 关系 | 本 spec 对它的改动 |
| --- | --- | --- |
| [`local-infra.md`](./local-infra.md) | **引擎层**：本 spec 消费它的就绪判定与调用 | ⏸️ **v1 不改它的端口**（就绪由 `doctor()` 报告投影，§8.3）；§7.10「与 OCR 能力的接线」改为指向本 spec |
| [`capability-registry.md`](./capability-registry.md) | **能力调用面**：本 spec 在它**上面**一层 | ⏸️ v1 不改（整块未实现）；将来注册表的 `CapabilitySummary` 要带就绪状态 |
| [`message-attachments.md`](./message-attachments.md) | **触发点**：附件解析链 | **要改**：PDF 分支增加「本地 OCR」路线；「不支持 PDF 的模型必须收到明确错误文本」改为「模型既不支持 PDF 也不支持图片时走本地 OCR，不就位才报错」 |
| [`ocr-local.md`](./ocr-local.md) | **OCR 能力的输入/输出契约** | ⏸️ v1 不改（能力层整块未实现）；`OcrCapabilityInput` 补 `engine` / `tier` 一条由 local-infra §10 登记 |
| [`tool/00-tool-change-chain.md`](./tool/00-tool-change-chain.md) | tool 改动的端到端链路 | ⚠️ **要改**：本 spec 改了附件 → prompt 的投影路径（CLI AGENTS.md：改 tool / adapter / 投影前必须先读并更新它） |
| `adapters/src/config/schema.ts` 的 `ocrConfigSchema` | 配置层 | **要改**：新增 `degradation` 键（§8.3） |
| [`model-assets.md`](./model-assets.md) | **第 2 步的依赖**：资产托管 | ⏸️ v1 不改 |
| [`audio-input.md`](./audio-input.md) | 相邻能力（转写），whisper 是外部已安装依赖 | ⏸️ v1 不改；但判定表按可扩展设计（§7.2 的表要能加行） |
| `contracts` 的 `WorkspaceResourceVariant.kind` | 产物登记的 kind 闭集 | ⚠️ **要改**：新增 `ocr` kind（对外契约变更） |

⚠️ **同步清单里的「要改」都是 spec 层面的改动** —— 按 AGENTS.md「新增或修改行为前，先更新对应 spec」，第 1 步动手时**先改这几份 spec，再写代码**。

## 12. 未决问题

| 编号 | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| O1 | **电子版 PDF 在「模型不支持 PDF 也不支持图片」时也要走 MinerU**（v1 不区分扫描件） | 慢；后续可用引擎的文本层探测做快路 | 待定（§7.2） |
| O2 | 判定规则表落在 `resource-policy` 里还是独立模块 | —— | ✅ **已定**：独立模块（机器级 vs workspace 级 + 版本冲突，§8.2） |
| O3 | **首轮要不要阻塞**：备资产可能要下 1.2GB，是「备好再发第一轮」还是「先发一轮、后台备」 | 延迟模型；后者要处理一半结果已出去的状态 | 待定（第 2 步） |
| O4 | **退云端的授权形态**：一次性询问 / 配置项 / 每次任务 | D6 的落地形态 | 待定（第 3 步） |
| O5 | 能力键与本层的边界 | —— | ✅ **已定**：本层叫 readiness / provisioning，不叫 capability（§8.1） |
| O6 | **就绪状态在多窗口 / 多 workspace 下的共享** | 就绪是机器级的，但探测有成本；多窗口各探一次浪费 | 待定（§9.1）—— v1 先「每任务一次」，跨任务不缓存 |
| O7 | **inline PDF（粘贴 / data URL）也要能走本地 OCR** | 需先物化路径 + 定 inline 产物的落点 | 待定（§8.3，v1 不做） |
| O8 | **`doctor()` 的探测成本是否可接受**（每次会 spawn `hardware detect` + `models show`） | 太慢就要拆一个只查 ①②③ 的 `readiness()` 端口方法（会改 local-infra 契约） | ⚠️ **待实测**（第 1 步落地时量一次） |
| O9 | **就绪状态的产物登记 kind**：`ocr` 是新增 kind，还是复用 `transcript` | 对外契约变更的幅度 | 待定（§8.3） |
