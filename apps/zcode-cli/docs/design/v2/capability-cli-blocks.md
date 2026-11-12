# 能力积木 CLI（业务侧积木模型）

Status: **规划稿 v2.2**（2026-11-12）：形态已与用户对齐定稿；**步 0–3 已实施**（统一信封 + 错误码闭集、`zcode ocr` 的信封迁移与 stderr 分流、sidecar v3 与缓存接力）；**`--pdf-password` 的加密 PDF 路线已落地**（v2.2 订正 v2.1 的失实表述）。
⚠️ **步 4（`zcode ocr inspect`）未开工** —— 依赖 §12 的 O1（数字版 PDF 原生分析的技术路线）未决。
⚠️ 本 spec **推翻** [`capability-registry.md`](./capability-registry.md) §4.2 的「统一执行面 `zcode cap run` + 不新增子命令路由到每个能力」，并**修订** [`ocr-local.md`](./ocr-local.md) §6.1 / §6.1.1（sidecar 格式）与 §6.5（交付形态）。冲突处以本 spec 为准。

## 1. 目的与范围

**zcode 的 CLI 就是业务侧要用的积木。** 业务拿一堆原子命令，自己写代码 / 脚本把它们拼成场景逻辑（先干什么后干什么、怎么合并结果、失败怎么重试，全归业务）。

> ⚠️ **场景归业务。** 「律师阅卷」「考生试卷扫描」这类场景差异**不进 zcode** —— zcode 里不出现场景字样。同一份 OCR 原子，被不同场景按不同参数用出不同效果。

本 spec 定义**积木模型本身**：族与原子动词的划分、积木的硬约束、参数契约、统一信封与退出码、产物 sidecar 契约、积木之间的接力与缓存、进度通道、交付给业务的形式。

**本 spec 不定义**各个能力自身的业务规则（OCR 的引擎链见 [`ocr-local.md`](./ocr-local.md)，能力供给的决策规则见 [`capability-provisioning.md`](./capability-provisioning.md)）。

### 1.1 一句话模型

```
业务代码
  ├─ 调 zcode ocr inspect --path a.pdf   →  拿页成分 + 元素位置
  ├─ 调 zcode ocr parse   --path a.pdf   →  拿文字 / markdown
  ├─ 调 zcode llm ask     --input q.json →  拿模型结论
  └─ 自己决定顺序、并发、重试、怎么合并          ← 业务的事
```

zcode 一侧只保证三件事：

| 保证 | 含义 |
| --- | --- |
| **每个积木自包含** | 一次调用干完一件事，业务不维护中间状态、不做「先 prepare 再 run 再 collect」的多步协议 |
| **每个积木契约稳定** | 业务会写代码解析它的输出 ⇒ 信封与退出码是对外公共契约 |
| **每个积木内部过程自决** | 选哪条引擎、要不要先备权重、不可用时怎么降级 —— 业务看不见，也不需要知道 |

## 2. 已定决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| **D1** | **CLI 是业务接入面**，业务拿原子命令自己编排；zcode **不提供**场景入口、不替业务编排 | 场景差异归业务；业务侧保留全部编排自由度 |
| **D2** | **一个能力域一个命令组**，组与组**平级**、互不嵌套：`zcode ocr` / `zcode llm` / `zcode asr` / `zcode asset` | 沿用 [`local-infra.md`](./local-infra.md) §7.3 的 CLI 原子化决策 |
| **D3** | **不设第二个 bin**，全部是 `zcode` 的子命令组；发行链 / SEA / 桌面**零改动** | 同上（M5） |
| **D4** | **不设 `zcode cap run` 通用执行面** | ⚠️ 推翻 `capability-registry.md` §4.2。通用入口让 `zcode --help` 随能力数线性膨胀，且参数无法按域校验；族命令组让每个域的参数自然收敛 |
| **D5** | **积木间接力靠 sidecar 缓存**，业务**只传原始路径**，不手搬上一步的产物路径 | 业务代码极简；天然幂等（重试不重复烧一次识别）；缓存命中与接力是同一件事 |
| **D6** | **统一信封 + 统一退出码**，所有**业务积木**一套 | 业务要写**一套**解析器吃所有业务积木的输出 |
| **D7** | **sidecar 格式归 zcode 定、与引擎无关**；引擎原生产物降级为调试副产物 | 业务一旦直接读 MinerU 的产物格式，换引擎 / 升 MinerU 时业务解析代码全废 |
| **D8** | **包层位走路线 (a) 契约下沉**：契约进 `packages/contracts/src/capability-blocks/`，实现进 `packages/core/src/capability/`，装配进 `packages/bootstrap/` | 不新增架构层、不改 `architecture.md`；`core → contracts` 合规。⚠️ **v2.1：bootstrap 装配随内置工具投影（O4）一起做** —— CLI 命令面有**自己的组合根**（`packages/cli/src/ocr/index.ts`），本批不经过 bootstrap |
| **D9** | **页成分给第四态 `empty`**（空白页） | 只给「纯文本 / 纯图片 / 文本+图片」三态时，空白页要靠「没有元素」反推 |
| **D10** | **引擎与 Python 环境由用户自装**；ZCode 只备**权重 / 语言包**等资产 | 沿用 [`local-infra.md`](./local-infra.md) §3.1 |
| **D11** | **自动备资产默认开**（`ocr.autoProvision` 默认 `true`） | 产品承诺是「ZCode 自己把能力拉起来，用户不感知命令」 |
| **D12** | **统一 sidecar 版本号 = `3`**（v1 = tesseract 变体、v2 = MinerU 变体，均**已废止**） | 两个旧变体的版本号已被既有 spec 占用；复用会让「version: 1」同时指两种不兼容的 schema。⇒ 统一格式走 v3，语义单调可追 |
| **D13** | **信封 `key` = 积木 id**（`<族>.<动词>`），取值是**闭集**；它与注册表能力键（`ocr`）是**两个命名空间** | 业务要按 `key` 分支；取值必须可校验、可枚举。⇒ 见 §5.1 的闭集与对照表 |
| **D14** | **运维面动词（`doctor` / `models download`）单列契约**：`doctor` 恒 `ok: true`、退出码恒 0 | 体检报告本身就是结果（[`local-infra.md`](./local-infra.md) §7.4 已定），与「引擎不可用 ⇒ 退出码 1」冲突，必须分开 |
| **D15** | **积木要有进度**：进度事件走 **stderr**，业务逐行可解析 | OCR 可能是分钟级（备权重 + 识别）；业务同步等一个长命令时无从判断死活（O5 已定） |
| **D16** | **`zcode ocr` 积木收 `--pdf-password`**（只经 argv） | 加密 PDF 在积木形态下要有路；密码只经 argv、不落盘、不入日志。⚠️ **v2.2 订正**：密码**不由引擎消费**（MinerU 4.1.7 无密码入口）⇒ ZCode 侧 poppler **前置解密**（[`ocr-local.md`](./ocr-local.md) §3.2.1） |

## 3. 积木模型

### 3.1 族与原子动词

**族 = 一个能力域**，组内是**原子动词**（一个动作一个命令）。

| 族 | 域 | 归属 spec | 状态 |
| --- | --- | --- | --- |
| `zcode ocr` | 文档版面 + 文字识别 | [`ocr-local.md`](./ocr-local.md) / [`local-infra.md`](./local-infra.md) | **v1 实现这一族** |
| `zcode llm` | 模型调用 | 无（待写） | ⏸ 无归属 spec，实施前必须补（O6 已定「暂不定」） |
| `zcode asr` | 音频转写 | [`audio-input.md`](./audio-input.md)（覆盖云端附件，不含本地命令组） | ⏸ |
| `zcode asset` | 资产（权重 / 语言包） | [`model-assets.md`](./model-assets.md) | ⏸ 延期（占位地址未换，见 `local-infra.md` §7.3） |

**v1 的 `zcode ocr` 原子动词**

| 动词 | 干什么 | 面 |
| --- | --- | --- |
| `zcode ocr inspect --path <文件>` | 页成分 + 元素位置（**不返回文字正文**） | **业务积木** |
| `zcode ocr parse --path <文件>` | 文字 / markdown（**顺带带出页成分与位置**） | **业务积木** |
| `zcode ocr doctor [--json]` | 引擎体检（只读，不下载任何权重） | 运维面（D14） |
| `zcode ocr models download --tier <档位>` | 下载档位权重 | 运维面（D14） |

⚠️ **两条分析路线**（同一份 PDF 走哪条由输入类型决定，**不由业务指定**）：

| 路线 | 何时走 | 要什么 | 产出 |
| --- | --- | --- | --- |
| **PDF 原生分析**（`route: "pdf-native"`） | **数字版 PDF**（有文本层） | poppler（见 §4.3） | 页成分 + 文本位置 + 文本内容（从文本层直取） |
| **识别**（`route: "mineru"`） | **扫描件 / 图片型 PDF**（无文本层） | MinerU + 权重 | 页成分 + 文本位置 + 文本内容 + 图片位置 |

⚠️ **为什么 `inspect` 和 `parse` 是两个积木而不是一个**：按需付费。业务常常只需要「这页是纯文本还是纯图片、图和文各在哪」，**不该被迫付一次完整识别 + markdown 产物的代价**。数字版 PDF 上 `inspect` 走原生分析（不需要权重）；扫描件上判定页成分**必须**先识别（扫描件就是一张位图，不识别不知道上面有没有字）⇒ 扫描件上 `inspect` 的代价与 `parse` 同量级，这是**输入决定的**，不是 zcode 能省的。

⚠️ **`inspect` 不返回文字正文，但产物里有逐元素文字** —— `inspect` 写的 sidecar 里，每个文本类元素带 `text`（D7 的统一格式）⇒ `parse` 能直接从它派生文字，**不必再跑一次引擎**（§6.5 的接力矩阵）。⚠️ **文档级全文（markdown 正文）不进 sidecar**，只在 `text.markdownPath` 指向的产物里。

### 3.2 积木的三条硬约束

1. **自包含**：一次调用 = 一件事。不存在「必须先跑 A 再跑 B 才能让 C 有意义」的协议。
2. **契约稳定**：输出信封、退出码、产物格式都是对外承诺。字段增删 / 语义变更走版本递增（§5.3）。
3. **过程自决**：积木内部自己决定走哪条路线、要不要备资产、不可用时怎么办（§7）。**业务看不到这些决策，也不需要为它们写分支。**

### 3.3 并发与幂等

⚠️ **业务会并发调多个积木**（批量任务并行度通常是 4~8），因此：

| 关注点 | 要求 |
| --- | --- |
| **无全局锁** | 积木之间不互斥；不同文件并发跑不互相阻塞 |
| **临时文件唯一** | 临时目录 / 文件名必须带进程级唯一后缀（`randomUUID` 已在适配层可用） |
| **sidecar 写入原子** | 先写临时文件再 rename（[`ocr-local.md`](./ocr-local.md) §7 已定）；同文件并发写时**后写者胜**，读者永远读到完整 JSON（⚠️ **内容可能不同** —— 两次并发可能落在不同档位 / 不同 bbox，不承诺「内容等价」） |
| **同文件并发识别** | 允许重复计算，**不做跨进程锁** —— 锁的复杂度与跨平台差异不值得，业务侧重试成本本来就低 |
| **幂等** | 相同输入 + 相同引擎状态 ⇒ 相同产物；重试不产生副作用残留（⚠️ `--force` 除外，见 §4.2） |

### 3.4 什么**不**构成积木

| 不是积木 | 归谁 |
| --- | --- |
| 场景流程（阅卷 / 扫描的编排） | **业务** |
| 「注入一份要求，zcode 自己决定整条流程」的声明式入口 | **不存在**（D1；业务注入的是**参数**，不是一个要求对象） |
| 资产目录下载（`zcode asset` 的在线路径） | 延期，占位地址未换（`local-infra.md` §7.3） |
| 知识检索（`zcode knowledge index\|search`） | runtime 子系统，不走积木模型（`capability-registry.md` §1） |

## 4. 参数契约

### 4.1 通用约定

| 约定 | 规定 |
| --- | --- |
| **只用长名旗标** | `-p` 被 `--prompt` 占用（`local-infra.md` M14）。⚠️ **全局表里已有若干短名**（`-h` / `-p` / `-v` / `-c` / `-a` / `-s` / `-f`），积木**不新增**短名，**也不承诺「积木没有短名」** |
| **旗标必须在全局表注册** | `packages/cli/src/arguments.ts` 是 `strict: true` 的全局解析器，未注册的旗标在进分派表之前就报「未知参数」 |
| **`--json` 是复用的既有旗标** | 已存在于全局表（`usage` / `plugins` 在用）⇒ **不得重复注册** |
| **`--force` 也是复用的既有旗标** | 已注册在全局表且带短名 `-f`（`arguments.ts`）。⚠️ **它不是 `zcode ocr` 独占**：`zcode plugins` 里的 `--force` 是「非交互时跳过卸载确认」，语义不同 —— 同名不同义在仓库里已有先例（`path` / `output` / `tier`），**本 spec 明说这是有意的**，不做全局改名 |
| ⚠️ **`--force` 的现状坑** | ~~今天 `zcode ocr parse --force` 能通过全局解析，但 `OcrFlags` **没有 `force` 字段**…~~ ✅ **已修（v2.1，步 2/3）**：`OcrFlags` 已有 `force` / `pdfPassword`，`parse` 的允许集合含 `--force` / `--pdf-password`，语义见 §4.2 |
| **输出目录是显式参数** | 产物落在 `--output` 指定的目录；不指定时用 `<源文件名>.mineru/`（⚠️ **含扩展名**，`扫描件.pdf` → `扫描件.pdf.mineru/`；现有行为，见 `local-infra.md` §7.3） |
| **旗标只做「哪个积木收哪些」的组合校验** | 旗标语义由积木自己解释；全局表只负责「认不认识」 |

### 4.2 v1 各积木的参数

| 积木 | 参数 | 说明 |
| --- | --- | --- |
| `zcode ocr inspect` | `--path <文件>`（必填）、`--output <目录>`、`--json`、`--force` | 只出页成分 + 元素位置，**不返回文字正文**。`--output` 是**产物目录**（渲染出的整页图 / 引擎裁图落这里），不是「只写一个结果文件」 |
| `zcode ocr parse` | `--path <文件>`（必填）、`--output <目录>`、`--tier <档位>`、`--pdf-password <密码>`、`--json`、`--force` | 出文字 + markdown + 页成分 + 位置 |
| `zcode ocr doctor` | `--json` | 只读 |
| `zcode ocr models download` | `--tier <basic\|standard>`（必填）、`--source <auto\|huggingface\|modelscope>`、`--json` | 引擎只接受 basic / standard（实测 `mineru-kit models download --help`） |

⚠️ **`--force` 的语义**：忽略 sidecar 缓存，强制重算并覆盖 sidecar。**默认（不带）命中缓存直接返回**（D5）。⚠️ 这是**破坏性**的（覆盖已有产物）⇒ 破坏性动作在契约里显式命名，不做隐式行为。

⚠️ **`--pdf-password`（D16）**：加密 PDF 的密码，**只经 argv 传递，不落盘、不入日志**（沿用 `pdf-document.port.ts` 约定）。⚠️ **v2.1 的说法不准确，v2.2 订正**：密码**不会**透传给 MinerU —— MinerU 4.1.7 **没有任何密码入口**（实测：`mineru-kit parse <加密.pdf>` 报 `Failed to load document (PDFium: Incorrect password error).`；`mineru-kit parse --help` 无 `--password`）。v2.1 里密码实际只到得了 poppler 的页数探测 ⇒ **flag 被接受但对解析没有作用**。
✅ **v2.2 起**：端口在**调引擎前**用 poppler 探加密状态 —— **未给密码 ⇒ 直接报 `invalid_input`（hint 指向 `--pdf-password`），不空跑一次引擎**；**给了密码 ⇒ 先用 poppler `pdftocairo` 解出临时无密副本再交给引擎**（解密路线见 [`ocr-local.md`](./ocr-local.md) §3.2.1）。⇒ [`ocr-local.md`](./ocr-local.md) §8 的错误 hint 现在与行为对得上。
⚠️ **全局旗标表里的作用域检查要放行 `zcode ocr`**：`--pdf-password` 注册在 `zcode` 全局旗标表（`arguments.ts`），而 `run.ts` 有一条「**只服务无头链路**（`-p` / `--target`）」的作用域检查 —— **`zcode ocr` 命令组是例外**（它自己消费这个 flag），否则会出现「收得到、用不了」（v2.1 的实测症状：`--pdf-password can only be used with --prompt or --target.`）。

⚠️ **不给积木加「批量」旗标**（`--input-dir` 之类）—— D1：批量是业务自己的编排（业务自己循环 / 并发）。zcode 只保证**单个文件**这条路径干净可靠。

### 4.3 积木的前置依赖（业务必须知道）

| 积木 | 输入类型 | 需要装什么 | 缺了会怎样 |
| --- | --- | --- | --- |
| `inspect` / `parse` | **数字版 PDF** | **poppler**（用户自装，配 `ocr.popplerPath`；⚠️ Windows 上默认不进 PATH） | `unavailable` + 装法 hint（§7） |
| `inspect` / `parse` | **扫描件 / 图片** | MinerU + 对应档位权重 | 权重 ⇒ 自动备（D11）；引擎本身缺失 ⇒ `unavailable` + hint |
| `parse` | **加密 PDF** | 同上 + poppler 的 **`pdftocairo`**（poppler 自带，非新依赖） | 没装 poppler ⇒ 加密 PDF 走不通（`unavailable`）；**未加密 PDF 不受影响**（不会调 `pdftocairo`）。解密路线见 [`ocr-local.md`](./ocr-local.md) §3.2.1 |

⚠️ **poppler 是第三类依赖**（引擎、Python、权重之外）⇒ 必须写进业务接入说明，否则业务第一次调 `inspect` 就撞墙。

## 5. 统一信封与退出码

### 5.1 信封

沿用 [`capability-registry.md`](./capability-registry.md) §8 的信封（**本 spec 只定 `key` 的取值闭集，形状不改**）：

成功：

```json
{ "version": 1, "key": "ocr.inspect", "ok": true,
  "output": { "…": "积木自己的输出" },
  "metrics": { "durationMs": 1234 } }
```

失败：

```json
{ "version": 1, "key": "ocr.inspect", "ok": false,
  "error": { "code": "unavailable", "message": "…", "hint": "…", "details": { "…": {} } } }
```

⚠️ **成功信封的 `output` 里不放业务产物本体**，只放**产物引用**（sidecar 路径、产物摘要、缓存命中标记等）。产物本体在磁盘上（§6）—— 业务要的是文件，不是塞进 stdout 的一大坨 JSON。

#### `key` 的取值闭集（D13）

| `key` | 积木 | 面 |
| --- | --- | --- |
| `ocr.inspect` | `zcode ocr inspect` | 业务积木 |
| `ocr.parse` | `zcode ocr parse` | 业务积木 |
| `ocr.doctor` | `zcode ocr doctor` | 运维面 |
| `ocr.models.download` | `zcode ocr models download` | 运维面 |

⚠️ **取值闭集 = 上表**。新增积木 ⇒ **必须**同时往本表加一行并递增信封 `version`（§5.3）⇒ 业务可以为 `key` 写穷举校验。

⚠️ **`key`（积木 id）与注册表能力键不是一回事** —— 这是**两个命名空间**，不是同一个东西的两套写法：

| 命名空间 | 取值 | 载体 | 语义 |
| --- | --- | --- | --- |
| **积木 id**（本 spec 的 `key`） | `ocr.inspect` / `ocr.parse` / … | CLI 面信封的 `key` | 「**哪个积木**被调用了」⇒ 业务按它分支 |
| **注册表能力键** | `ocr` / `doc.parse` / `vision.describe` … | `CapabilityRegistry` | 「**这件能力**怎么做」⇒ 三投影共用一份实现 |

⚠️ **一个能力键可以对应多个积木**（`ocr` ⇒ `ocr.inspect` + `ocr.parse`）。⚠️ **MCP 投影（§4.3 保留）与内置工具投影（§4.4）仍发能力键**（`ocr`），**CLI 投影发积木 id** —— 这是**有意的差异**，不是漂移：业务主接入面是 CLI，业务只解析 CLI 面；两个投影的 `key` 不通用。

### 5.2 退出码与错误码

沿用 [`capability-registry.md`](./capability-registry.md) §7：

| 情形 | `error.code` | 退出码 |
| --- | --- | --- |
| 成功 | — | `0` |
| `unsupported_input` / `invalid_input` / `unavailable` / `not_found` / `permission_denied` / `internal` | 同名 | `1` |
| `cancelled` | `cancelled` | `130` |
| `timeout` | `timeout` | `124` |

⚠️ **对外只有这一个错误码闭集**（8 个）。引擎层 / 资产层的细粒度码**一律归一**，原始码放 `details.engineCode` / `details.assetCode`。

### 5.3 版本

- **信封 `version`**：字段增删或退出码语义变更 ⇒ **递增 `version`** 并同步业务方，不能悄悄改。
- **sidecar `version`**：产物格式变更 ⇒ 递增；旧版 sidecar 视为无效 ⇒ 重新计算（D5 的缓存命中判据之一）。

### 5.4 ⚠️ 迁移：现有 `zcode ocr` 的信封要改

现在 `zcode ocr parse --json` 的输出是**另一套形状**：

```json
{ "ok": true, "engine": "mineru", "tier": "basic",
  "output": { "outputDir": "…", "markdownPath": "…", "structuredContentPath": "…", "middleJsonPath": "…" },
  "warnings": [], "durationMs": 9937 }
```

—— 没有 `version`、没有 `key`，`warnings` 在顶层而不在 `metrics` 里。⇒ **本 spec 实施时必须迁到 §5.1 的统一信封**。

⚠️ **迁移清单（逐字段，不许漏）**：

| 现字段 | 去处 |
| --- | --- |
| `ok` | 信封 `ok`（不变） |
| `engine` | `output.engine`（或 sidecar 的 `engine` 块） |
| `tier` | `output.tier`（或 sidecar 的 `engine.tier`） |
| `output.outputDir` | `output.artifactsDir`（§6.2 的 sidecar 相对路径基准，⚠️ 单位要从绝对路径改成相对 sidecar 目录） |
| `output.markdownPath` / `structuredContentPath` / `middleJsonPath` | `output.artifacts`（产物引用，§6.2 的路径基准） |
| `warnings`（顶层） | `metrics.warnings` |
| `durationMs`（顶层） | `metrics.durationMs` |
| ⚠️ `degradedFrom`（档位降级来源，现状在顶层） | `metrics.degradedFrom`（**降级不是错误**，不进 `error`） |
| ⚠️ `error`（现状失败时的形状） | 信封 `error`（§5.1 的 8 码闭集 + `hint` + `details`） |

⚠️ **业务尚未接入 ⇒ 这是零兼容负担的窗口**：迁完就定型。

### 5.5 运维面动词的单列契约（D14）

⚠️ **运维面不是业务积木，契约不同** —— 混用会同时违反本 spec 与 [`local-infra.md`](./local-infra.md) §7.4：

| 动词 | `ok` | 退出码 | 说明 |
| --- | --- | --- | --- |
| `zcode ocr doctor` | **恒 `true`** | **恒 `0`**（除非参数非法） | 体检报告本身就是结果；「引擎不可用」是**有效报告**（落在 `output.report` 的字段里），不是命令失败 |
| `zcode ocr models download` | 成功 `true` / 失败 `false` | `0` / `1` | 失败按 §5.2 的 8 码闭集 |

⚠️ **因此 §5.1 的信封形状对运维面也适用**（`version` / `key` / `ok` / `output`），**但 `ok` 与退出码的语义按本表**。doctor 的报告体放在 `output.report`（原样是 `LocalInfraDoctorReport` 的结构），**不放 `error`**。

### 5.6 进度通道（D15）

⚠️ **积木的耗时可能到分钟级**（下载 1.2GB 权重 + 识别）⇒ 必须有进度。

| 项 | 规定 |
| --- | --- |
| **通道** | **stderr**。stdout 留给最终信封（`--json` 时 stdout **只有**那一个 JSON 对象） |
| **格式** | **每行一个 NDJSON 事件**：`{"type":"progress","phase":"provision\|analyze\|write","message":"…","percent":null}`。⚠️ `percent` 可为 `null`（阶段内进度不可知，如引擎内部推理） |
| **`--json` 时** | stderr 是**纯进度流**；⚠️ **错误不进 stderr**，只在 stdout 信封里 + 退出码 ⇒ 业务逐行解析 stderr 不会混进非 JSON 行 |
| **无 `--json` 时** | stderr 是人读文本（进度行 + **末尾一行错误**） |
| **阶段语义** | `provision` = 备资产（下载权重 / 语言包）；`analyze` = 识别 / 原生分析；`write` = 落产物与 sidecar |
| **频率** | ≥ 1 次/秒，或每个阶段切换时必发；**结束前必须发最后一个事件** |

✅ **已实施（v2.1，步 2）**：进度走 `packages/cli/src/ocr/output.ts` 的 `createReporter` —— `--json` 时 stderr 每行一个 NDJSON 事件（`type: "progress"`），**错误不进 stderr**（只在 stdout 信封里 + 退出码）；无 `--json` 时 stderr 是人读文本。引擎自己的 stdout（`已解析 1 个输入。`）作为 `analyze` 阶段的进度转发，**不混进 stdout**。

### 5.7 `ocr.parse` 的 `output` 形状（v2.1 实施定稿）

```jsonc
"output": {
  "cached": false,                      // true = 命中 sidecar 缓存（**没重新识别**）
  "sidecarPath": "/abs/扫描件.pdf.zcode-ocr.json",
  "artifactsDir": "扫描件.pdf.mineru",  // ⚠️ **相对 sidecar 所在目录**
  "engine": "mineru",
  "tier": "basic",
  "artifacts": {                        // ⚠️ 每个路径**相对 artifactsDir**
    "markdownPath": "report.md",
    "structuredContentPath": "structured_content.json",
    "middleJsonPath": "middle_json.json",
    "assetsDir": "images"
  }
}
```

⚠️ **`cached` 是业务判断「这次有没有再烧一次识别」的依据** —— `true` 表示直接复用了 sidecar，`false` 表示真的跑了一遍引擎。
⚠️ **命中缓存时 `artifacts` 只有 sidecar 里记着的 markdown 路径**（sidecar 不记结构化产物的路径 —— 它们是引擎原生产物，调试用）。
⚠️ **请求没给 `--tier` 而命中了缓存时**，`output.tier` 是 sidecar 里的实际档位，且 `metrics.warnings` 里有一条「本次用的是 sidecar 里的档位 X」⇒ 业务看得见实际用了哪一档。

## 6. 产物 sidecar 契约

### 6.1 位置与命名

路径：`<源文件目录>/<源文件名>.zcode-ocr.json`（例：`扫描件.pdf.zcode-ocr.json`）。

⚠️ **`<源文件名>` 含扩展名** —— 不是去扩展名的基名（沿用 `ocr-local.md` §6.1 的约定，业务拼路径时别搞错）。

⚠️ **sidecar 是引擎无关的统一格式**（D7）。[`ocr-local.md`](./ocr-local.md) §6.1（tesseract 变体 v1）与 §6.1.1（MinerU 变体 v2）是**已废止的历史变体**，最终都归一到本节的统一格式（**v3**）；引擎的差异全部下沉到 `engine` 块里。**业务只认本节这一份。**

### 6.2 统一 sidecar v3（D12）

```jsonc
{
  "version": 3,
  "source": { "path": "扫描件.pdf", "sha256": "…", "bytes": 4821003, "mtimeMs": 1762000000000 },
  "engine": {
    "name": "mineru",              // "mineru" | "pdf-native"
    "variant": "mineru",           // 引擎变体名
    "version": "4.1.7",            // 引擎版本（pdf-native 时为 zcode 内建分析器版本）
    "tier": "basic",               // 档位（pdf-native 路线恒为 "native"）
    "route": "mineru",             // 内部路线，业务不依赖
    "assets": {}                   // 用到的资产（语言包 / 权重组）
  },
  "artifactsDir": "扫描件.pdf.mineru", // ⚠️ 产物根目录，**相对本 sidecar 所在目录**
  "pages": [
    {
      "pageIndex": 0,              // 0 基
      "widthPt": 595.3,
      "heightPt": 841.9,           // ⚠️ bbox 的分母
      "status": "ok",              // "ok" | "failed"
      "composition": "text+image", // "text" | "image" | "text+image" | "other" | "empty" | null(failed)
      "otherElements": 0,          // 未归类元素计数
      "elements": [
        { "category": "text",  "type": "paragraph_title", "origin": "engine",
          "bbox": [0.117, 0.086, 0.379, 0.113], "text": "证据材料一" },
        { "category": "image", "type": "image", "origin": "engine",
          "bbox": [0.300, 0.400, 0.700, 0.720], "imagePath": "images/fig1.jpg" },
        { "category": "image", "type": "page", "origin": "rendered",
          "bbox": [0, 0, 1, 1], "imagePath": "images/page-1.png" }
      ]
    }
  ],
  "text": { "markdownPath": "markdown.md" }   // 可选；**相对 artifactsDir**
}
```

⚠️ **`elements[]` 的 `type` 是开放字符串**（不是封闭枚举）：实测出现过 `text` / `paragraph_title` / `table` / `image` / `chart`，且**类型名随档位变**（standard / flash 叫 `image`，advanced 叫 `chart`）（`local-infra.md` §11.0 已记实测）。⇒ schema **必须允许额外字段**。

⚠️ **图片块的载荷是空字符串**（图片本体只由 `imagePath` 指向）⇒ `elements[]` 用 `text` 字段（不是 `content`）承载文本类内容，图片类**不给** `text`。

⚠️ **`origin` 区分两类图片元素**：
- `"engine"` = 引擎从版面里裁出来的图（bbox 是它在页面上的位置）；
- `"rendered"` = **ZCode 自己渲染的整页图** —— ⚠️ **扫描页天然是「一张图就是一张图」**（整页扫描件 ⇒ 页面本身就是一张位图，没有更细的版面结构）⇒ ZCode 为扫描页**合成**一个覆盖整页的 image 元素（`bbox = [0,0,1,1]`），`imagePath` 指向渲染出的整页图。⇒ 业务在扫描件上拿到的「图片位置」就是整页。

⚠️ **文档级全文不进 sidecar** —— sidecar 只有**逐元素**的 `text`；文档正文在 `text.markdownPath` 指向的产物里。

#### 路径基准（写死，业务必须知道）

| 路径字段 | 基准 |
| --- | --- |
| `artifactsDir` | **相对 sidecar 所在目录**（例：`扫描件.pdf.mineru`） |
| `elements[].imagePath` | **相对 `artifactsDir`** |
| `text.markdownPath` | **相对 `artifactsDir`** |

⇒ 业务解析：`join(dirname(sidecarPath), artifactsDir, imagePath)`。
⚠️ **sidecar 与产物目录是分开的** —— sidecar 在源文件旁（`office-runtime` 只读同目录的文件就能拿到），产物在 `<源文件名>.mineru/`（**含扩展名**；或 `--output` 指定处）。

### 6.3 旧变体字段 → 统一字段映射（D12）

⚠️ 两个历史变体（`ocr-local.md` §6.1 v1 / §6.1.1 v2）**已废止**，业务只认 v3。迁移对照：

| 旧变体字段 | 统一字段 | 变化 |
| --- | --- | --- |
| `version: 1`（tesseract 变体） | `version: 3` | ⚠️ 版本号不复用 |
| `version: 2`（MinerU 变体） | `version: 3` | ⚠️ 版本号不复用 |
| `pages[].page`（**1 基**） | `pages[].pageIndex` | **0 基**（与 MinerU `page_idx` 一致） |
| `engine.pageWidthPt` / `pageHeightPt` | 页级 `widthPt` / `heightPt` | **从 engine 块挪到页对象**（分母跟着页走，不再是整份文档共用） |
| `pages[].pixelWidth` / `pixelHeight` / `dpi`（tesseract 变体） | 页级 `widthPt` / `heightPt` | ⚠️ 单位不同：tesseract 是**像素**，v3 是 **pt**；消费方自己乘 DPI |
| `pages[].blocks[].content` | `pages[].elements[].text` | 字段改名（`content` → `text`） |
| `pages[].blocks[].image_source` | `pages[].elements[].imagePath` | 字段改名 + **基准改为相对 `artifactsDir`** |
| `pages[].blocks[].type` | `pages[].elements[].type` + `category` | ⚠️ **新增 `category`**（分类结果，见 §6.4） |
| `pages[].text`（tesseract 变体的整页文本） | `pages[].elements[].text`（逐元素） | ⚠️ 粒度变了：**页级文本不再重复存储**，业务按元素顺序拼 |
| `pages[].words[]`（词级 + 置信度） | — | ⚠️ **v3 不保留词级切分**（MinerU 没有）；置信度 v3 一律无 |
| `strategy`（fill / override） | — | ⚠️ **v3 不保留**：统一格式没有「填坑 / 覆盖」两种语义，消费方按页读 |
| `engine.preprocess`（tesseract 变体） | — | v3 只留 `engine.assets`；预处理细节进日志，不进产物 |

⚠️ **`office-runtime` 的页锚点是 1 基**（`ocr-local.md` §6.2 记的 `page:N`）⇒ 换算：`page:N` ↔ `pageIndex = N - 1`。

### 6.4 页成分分类规则（写死，不许各写各的）

**判定输入**：`elements[]` 的 `category`。分类由**映射表**得出，**不直接比较 `type` 字符串** —— 因为 `type` 随档位变（D7 / §6.2）。

| `type`（已知值表） | `category` |
| --- | --- |
| `text` / `paragraph_title` | `text` |
| `table` | `text`（表格有内容，是文本） |
| `image` / `chart` / `page` | `image` |
| **其它任何值** | `other`（**不计入 text 也不计入 image**） |

**页成分判定（对 (hasText, hasImage, hasOther) 的**全枚举**，是全函数）**：

| hasText | hasImage | hasOther | `composition` |
| --- | --- | --- | --- |
| F | F | F | `empty`（**没有元素** ⇒ 空白页，D9） |
| F | F | T | `other`（有元素但一个都不认识） |
| T | F | F | `text` |
| T | F | T | `text`（⚠️ 未归类元素**只进 `otherElements` 计数**，不污染 composition） |
| F | T | F | `image` |
| F | T | T | `image`（同上） |
| T | T | F | `text+image` |
| T | T | T | `text+image`（同上） |

⚠️ **`other` 类元素不参与 composition，只累加 `otherElements`** —— 业务可自行决定「这一页算不算纯文本页」；zcode 不替业务决定，但**不隐瞒**（计数在页对象里）。

⚠️ **「数字版 PDF 没识别出内容」= `empty`** —— 用户已定：数字版 PDF 走原生分析，分析不出元素 ⇒ 该页就是空白页（`composition: "empty"`，`status: "ok"`），**不是失败**。

⚠️ **「识别失败的页」≠ 空白页** —— 页对象带 `status`：

| `status` | 含义 | `composition` | `elements` |
| --- | --- | --- | --- |
| `"ok"` | 该页分析成功（**含「没分析出东西」**） | 见上表 | 见上表 |
| `"failed"` | 该页**分析出错**（渲染失败 / 引擎非零退出 / 原生分析异常） | `null` | `[]` |

⇒ 业务能区分「这页是空白」与「这页我没分析出来」。⚠️ 失败页进 `metrics.warnings`（§7），**不中断整批**。

⚠️ **未知类型不静默吞掉**：页上给 `otherElements` 计数，让业务能看见「有东西我没认出来」。

⚠️ **图片位置 + 文本位置**由 `elements[]` 的 `bbox` 给出（归一化，`[x0,y0,x1,y1]`，分母是页级 `widthPt` / `heightPt`）。⚠️ **业务换算像素必须自己乘分母** —— zcode 不给像素坐标，因为渲染 DPI 是引擎侧的实现细节。

⚠️ **图片本体已由引擎裁好落盘**（`imagePath`）—— 业务直接拿文件，**不要自己按 bbox 裁**（自己裁会引入 DPI 差异，与 `ocr-local.md` 里 PGM 无 DPI 那个坑同类）。⚠️ **扫描页的整页图由 ZCode 渲染**（`origin: "rendered"`），业务同样直接用。

### 6.5 指纹、失效与接力（D5）

**缓存命中判据**（全部满足才算命中）：

1. sidecar 文件存在，且 `version` **等于当前版本（3）**；
2. `source.sha256` 与当前源文件一致（**内容指纹**，不只是 mtime —— mtime 会被复制 / 同步工具改）；
3. **档位判据**：
   - 请求**给了** `--tier` ⇒ 必须 `sidecar.engine.tier` **等于**请求档位，否则**不命中**；
   - 请求**没给** `--tier` ⇒ 命中任意档位，但 `metrics.warnings` 里提示「本次用的是 sidecar 里的档位 X」（业务看得见）；
4. **积木所需产物判据**：

| 积木 | 命中所需的 sidecar 内容 |
| --- | --- |
| `inspect` | `pages[]` 存在且每页有 `composition` + `elements[]` |
| `parse` | `pages[]` 存在 **且** 每页的文本类元素带 `text`（⇒ 文字可从 sidecar 直接取） |

⚠️ **命中时的行为**：`ok: true`，`output` 里带 `cached: true` 与产物路径，**不重算**。

⚠️ **未命中**：`ok: true`，`output.cached: false`，`output` 带产物路径。

⚠️ **`--force`**：跳过全部命中判据，强制重算并覆盖 sidecar（D5）。

#### 接力矩阵（业务能预判「第二次会不会再烧一次识别」）

| 前一次 | 后一次 | 是否命中 | 引擎是否再跑 |
| --- | --- | --- | --- |
| `inspect` | `inspect` | ✅ | **否** |
| `inspect` | `parse` | ✅（判据 4 满足 —— `inspect` 的 sidecar 里逐元素带 `text`） | **否** ⇒ `parse` 的文字直接从 sidecar 取，markdown 从 sidecar 派生或复用已有产物 |
| `parse` | `parse` | ✅ | **否** |
| `parse` | `inspect` | ✅（`parse` 是超集） | **否** |
| 任意 | 任意（**档位不符** / **sha256 变了** / **`--force`**） | ❌ | **是** ⇒ 重算并覆盖 sidecar |

⚠️ **⇒ 业务永远只传原始路径**（D5），不需要手搬上一步的产物路径。

⚠️ **`inspect` 的 sidecar 为什么能被 `parse` 复用**：`inspect` 不返回文字正文，但**产物里存了逐元素文字**（§3.1）—— 这不是为了业务看，是为了接力时不必重跑引擎。代价是 sidecar 体积随正文增长（**逐元素**文字，不是整份 markdown）。

⚠️ **markdown 产物的来源（写死）**：`parse` 的 markdown **优先复用** sidecar 的 `text.markdownPath` 指向的产物（识别路线下引擎已产出）；**没有**该产物时（原生分析路线），**从 sidecar 的元素派生**（按元素顺序：文本类输出 `text`、图片类输出 `![caption](imagePath)`、表格类输出 `text`）。⇒ 两条路线下 `parse` 都不需要再跑引擎。

### 6.6 原子写

sidecar 写入必须是「先写临时文件再 rename」（沿用 `ocr-local.md` §7），保证并发读者不会看到半截 JSON。

## 7. 积木内部的过程自决

积木**内部**的路线决策归**能力供给层**，规则表见 [`capability-provisioning.md`](./capability-provisioning.md)。本 spec 只补充与积木契约的接口：

| 决策点 | 积木内部行为 | 业务看到 |
| --- | --- | --- |
| 引擎不可用 | 报 `unavailable` + `hint`（装法） | `error.hint` 可直接转给用户 |
| ⚠️ **路线判定能力缺失**（数字版 PDF 但 poppler 不可用） | 报 `unavailable` + `hint`（装法，§4.3） | `error.hint`（**不静默退到识别路线** —— 那会让业务多付一次权重代价，且违背「本地基础设施」的可见性） |
| 档位就绪 | 直接用 | 无感 |
| 档位未就位 | **自动备资产**（默认开，D11），或按 `ocr.degradation` 降级 | 降级进 `metrics.warnings`，**不进 `error`**（降级不是错误） |
| 全部路线不可用 | 报 `unavailable` | `error.code` |
| 部分页失败 | **不中断整批**，失败页 `status: "failed"`，进 `metrics.warnings` | `ok: true` + warnings |

⚠️ **降级 / 部分成功都不是错误** —— 与 `ocr-local.md` §8 一致：只有「全链都不可用」才是 `unavailable`。

⚠️⚠️ **绝不传远端旗标**（红线，来自 [`local-infra.md`](./local-infra.md) §9.1）：`mineru-kit parse` 支持 `--remote` / `--remote-url` / `--api-key` 三个走远程解析的旗标。⇒ **ZCode 绝不构造、绝不传这三个**（积木的命令面**不暴露**对应选项，实现里也**不构造**这些参数）。理由：① 「本地基础设施」这个产品承诺不能被静默打破；② 用户全局的 `~/.mineru/config.yaml` 里 `parse_server.remote.url` 默认就是远端地址；③ **远程解析会把文档送出本机**。⇒ 回归断言位置：积木拼装的引擎 argv 里**不出现**这三个旗标名。

⚠️ **积木的耗时可能到分钟级**（下载 1.2GB 权重 + 识别）⇒ 进度通道见 §5.6（D15）。⚠️ **桌面端 / runtime 侧看不到 CLI 积木的进度**（那是另一条链路，见 §12 遗留项）。

## 8. 交付给业务的形式

| 项 | 规定 |
| --- | --- |
| **部署** | 业务客户端与 zcode **同机**，业务 **spawn 子进程**调积木 |
| **zcode 可执行文件的定位** | **由业务方负责**（配置文件或进程环境变量）。zcode 侧**不新增环境变量** |
| **业务怎么拿错误** | 退出码 + `--json` 时 stdout 信封的 `error`；**无 `--json` 时 stderr 末尾一行人读错误**（§5.6） |
| **业务怎么拿进度** | **stderr 逐行 NDJSON**（§5.6）。⚠️ `--json` 时 stderr 只有进度行，可直接逐行 `JSON.parse` |
| **业务怎么拿产物** | sidecar 文件路径（在 `output` 里）+ 磁盘上的产物 |
| **密码类输入** | 只经 argv 传递，**不落盘、不入日志**（沿用 `pdf-document.port.ts` 约定；D16） |
| **MCP 投影** | 保留（给 dsh 这类 MCP 宿主），但**不是**业务主接入面；见 `capability-registry.md` §4.3 |

⚠️ **子进程路线在批量场景下的成本**：每次调用付一次 node 启动（~200-400ms）+ 一次引擎探测。⚠️ **这是业务自己编排的代价，不是 zcode 的问题**（D1）—— 业务可以在自己的一侧拉一个常驻 worker 复用；zcode 侧不为此设计批量旗标（§3.4）。

## 9. 与既有 spec 的关系

| spec | 关系 |
| --- | --- |
| [`capability-registry.md`](./capability-registry.md) | ⚠️ **§4.2 修订**：投影 A 不再是 `zcode cap run`，改为族命令组（D4）。⚠️ **§2 修订**：「能力键走新命令 `zcode cap run <key>`」作废，能力键是**注册表**概念、CLI 面发的是**积木 id**（D13 / §5.1）。§3 契约 / §7 退出码 / §8 信封**沿用**。§4.3 MCP 投影保留但降级；§4.4 内置工具投影（agent 自用）不受影响 |
| [`ocr-local.md`](./ocr-local.md) | ⚠️ **§6.1 / §6.1.1 修订**：两个引擎变体 sidecar **作废**，统一到本 spec §6.2 的 **v3**（D12；对照表见 §6.3）。§6.5 修订：交付形态不再写死「子进程调 `zcode cap run ocr`」，改为「子进程调族积木」。§7 的 owner 表**标为历史记录**（tesseract 时代，多数行指向不存在的包），执行链路图按 D8 改写 |
| [`local-infra.md`](./local-infra.md) | §7.3 的命令组表**沿用**（`zcode ocr` 三个子命令），本 spec 补 `inspect` 积木与 `--force`；§5.4 的档位状态语义不变；§5.5 的 sidecar 字段名要求（`pageWidthPt` / `pageHeightPt`）按 §6.3 改为页级 `widthPt` / `heightPt` |
| [`capability-provisioning.md`](./capability-provisioning.md) | 路线决策规则**沿用**；本 spec 只定义它与积木契约的接口（§7） |
| [`model-assets.md`](./model-assets.md) | `zcode asset` 族延期，占位地址未换（`local-infra.md` §7.3）；本 spec 不动它 |
| [`audio-input.md`](./audio-input.md) | 云端 ASR 附件，不含本地命令组；`zcode asr` 族待写 spec（O6：暂不定） |
| [`commands.md`](./commands.md) | ⚠️ **§`zcode ocr` 条目修订**：补 `inspect` 子命令、`--force`、`--pdf-password`、统一信封与进度通道 |

## 10. 验收

### 10.1 契约

| 场景 | 断言 |
| --- | --- |
| 信封形状 | 所有**业务积木** `--json` 的 stdout 是**单个** JSON 对象，含 `version` / `key` / `ok`；成功带 `output` + `metrics`，失败带 `error` |
| `key` 取值 | `key` ∈ §5.1 的闭集（`ocr.inspect` / `ocr.parse` / `ocr.doctor` / `ocr.models.download`）；不在闭集里的值视为契约破坏 |
| 退出码 | 逐条对上 §5.2 的表（用假端口注入，不连真引擎） |
| 错误码闭集 | 对外 `error.code` 只取 8 个 `CapabilityErrorCode` 之一；引擎码只出现在 `details.engineCode` |
| 降级不是错误 | 档位降级 / 部分页失败 ⇒ `ok: true` + `metrics.warnings`，退出码 `0` |
| **运维面单列**（D14） | `doctor` ⇒ `ok: true` + 退出码 `0`（引擎缺失落在 `output.report` 里，不进 `error`）；`models download` 失败 ⇒ `ok: false` + 退出码 `1` |
| **旧信封已消失** | `zcode ocr parse --json` 不再出现顶层 `warnings` / `engine` / `tier` / `degradedFrom`；`engine` / `tier` 移进 `output` 或 sidecar，`warnings` / `degradedFrom` 进 `metrics` |
| **进度通道**（D15） | `--json` 时 stdout **只有**信封一个 JSON 对象；stderr 逐行是 `{"type":"progress",…}`；失败时 **stderr 无错误行**（错误只在 stdout 信封） |

### 10.2 sidecar

| 场景 | 断言 |
| --- | --- |
| 分类正确 | 纯文本页 ⇒ `text`；纯图片页 ⇒ `image`；混合 ⇒ `text+image`；空白页 ⇒ `empty` |
| **分类是全函数** | §6.4 的 8 行枚举逐行覆盖（实现里是一张查表，不许出现未覆盖分支） |
| **档位不改变分类** | 映射函数对 `type = "image"` 与 `type = "chart"` 归到**同一** `category`（映射表生效，不是字符串直比）—— ⚠️ 这是**单元层**断言，CLI 面没有 `--tier` 旗标给 `inspect` |
| 未知类型 | 新块类型 ⇒ `category: "other"`，**不**污染 `composition`，`otherElements` 计数 > 0 |
| **失败页 ≠ 空白页** | 分析出错的页 ⇒ `status: "failed"` + `composition: null` + `elements: []`，**不判 `empty`** |
| **数字版空白页** | 数字版 PDF 原生分析不出元素 ⇒ `status: "ok"` + `composition: "empty"` |
| 位置 | `bbox` 是归一化四元组；页级 `widthPt` / `heightPt` 与之一一对应 |
| 图片路径 | `elements[].imagePath` 按 §6.2 的基准解析后**指向的文件真实存在**；`artifactsDir` 相对 sidecar 目录可解析 |
| **扫描页整页图** | 扫描页有 `origin: "rendered"` 的 image 元素，`bbox = [0,0,1,1]` |
| 格式稳定 | sidecar 里**不出现** MinerU 专有键（`extensions.mineru` / `docvortex_layout`）；`elements[].type` 保持开放字符串 |
| 原子写 | 并发读 sidecar 永远读到完整 JSON |
| **接力**（§6.5 矩阵） | `inspect` 后调 `parse` ⇒ `cached: true`，**未重新调用引擎**（断言引擎端口未被再次调用）；`parse` 后调 `inspect` ⇒ 同样命中 |
| **档位判据** | 请求 `--tier` 与 sidecar 档位不同 ⇒ 不命中并重算；请求不给 `--tier` ⇒ 命中且 `metrics.warnings` 提示实际档位 |
| **指纹失效** | 源文件内容改动 ⇒ 缓存不命中，重新计算 |
| `--force` | 强制重算并覆盖 sidecar |

### 10.3 积木边界

| 场景 | 断言 |
| --- | --- |
| 自包含 | 每个积木单独调用即完成一件事，不需要前置步骤 |
| 并发 | 多个积木并发跑不互相阻塞、不互相污染产物 |
| 只读面 | `doctor` 不下载任何权重、不写任何产物 |
| 引擎不可用 | `unavailable` + `hint` 给装法；业务可直接把 hint 转给用户 |
| **远端旗标红线** | 积木拼装的引擎 argv 里**不出现** `--remote` / `--remote-url` / `--api-key`（§7） |

### 10.4 测试入口与落点（⚠️ 别踩 `capability-registry.md` §9 记的坑）

⚠️ **根 `pnpm test:engineering` 的清单里 `apps/zcode-cli/**` 是 0 条** —— 对这些包跑会得到「No test files found」**且不报错**，验收表形同虚设。⇒ 逐条落点：

| 断言组 | 落点 | 入口 |
| --- | --- | --- |
| §10.1 信封 / 退出码 / 错误码 / `key` 闭集 | `@zcode/core` 的 `tests/`（积木执行层）+ `@zcode/cli` 的 `tests/`（命令层） | core / cli 各包自己的 `pnpm test`；⚠️ **CLI 的测试必须显式登记进 `apps/zcode-cli/packages/cli/package.json` 的 `scripts.test` 清单**才会被跑 |
| §10.2 sidecar 分类 / 映射表 / 指纹 / 原子写 / 接力矩阵 | `@zcode/core` 的 `tests/`（纯函数：分类映射、命中判据）+ `@zcode/adapters` 的 `tests/`（原子写、路径解析） | 各包 `pnpm test`（vitest） |
| §10.3 边界（并发、只读、红线） | `@zcode/core` + `@zcode/cli` 的 `tests/`（引擎端口用假实现，断言 argv） | 同上 |
| **真引擎相关**（识别质量、真实 bbox、真实档位） | ❌ **不进 CI** | 端到端手测（需要装好引擎 + 权重） |

## 11. 实施顺序

| 步 | 内容 | 前置 | 状态 |
| --- | --- | --- | --- |
| 0 | **架构登记**：本次新增的**全部**目录逐个登记（见下方清单） | — | ✅ **已做**（两个模块，见下方清单） |
| 1 | **统一信封与错误码**：契约进 `packages/contracts/src/capability-blocks/`；实现进 `packages/core/src/capability/`；装配进 `packages/bootstrap/` | 0 | ✅ **已做**（契约 + 实现；bootstrap 装配随 O4 一起做，见下） |
| 2 | **迁移 `zcode ocr` 的信封**到统一信封（§5.4 的逐字段迁移清单）+ **修 stderr 分流**（错误行 / 进度行，§5.6） | 1 | ✅ **已做** |
| 3 | **sidecar v3**：统一格式 + 分类规则（全枚举）+ 指纹 + 原子写 + 接力（`--force`） | 2 | ✅ **已做** |
| 4 | **`zcode ocr inspect` 积木**：页成分 + 元素位置（数字版 PDF 走 PDF 原生分析，扫描件落识别路线） | 3 | ⏸ **未开工**（O1 未决） |
| 5 | **`zcode ocr parse` 补齐**产物（文字 / markdown 进同一份 sidecar；markdown 派生规则见 §6.5） | 4 | ⏸ 未开工（依赖步 4） |
| 6 | **同步旧 spec 口径**：把 §9 表里列的 6 份 spec 的过期引用改掉（`zcode cap run` / `--input` / 旧 sidecar 字段名 / `zcode cap describe`） | 1 | ⏸ 未做 |
| 7 | 契约文档化：`zcode ocr --help` 的族内动词表 + 业务接入说明（含 §4.3 的前置依赖） | 5 | 🟡 **部分**：`zcode ocr --help` 已含旗标与产物说明；业务接入说明未写 |

#### 步 0 的架构登记清单（D8）

⚠️ **`apps/zcode-cli` 在 `architecture-policy.yaml` 里是 `managed: false`** ⇒ **任何新增 `.ts` 文件落在 `apps/zcode-cli/**` 下都会触发 `unmanaged-new-file`**（`scripts/architecture/violations.mjs`）。⇒ 步 0 **必须**把下列目录**全部**登记（逐个 `pnpm architecture:adopt <id> --root <dir>`，或按 `architecture-policy.yaml` 的 `exceptions:` 逐文件登记）：

| 新增目录 | 建议模块 id | 备注 |
| --- | --- | --- |
| `packages/contracts/src/capability-blocks/` | `cli-capability-blocks` | ✅ **已登记**。⚠️ **不叫 `capabilities`** —— 那个目录已存在（provider / model 能力描述的空壳），见 D8 与 §12 遗留项 |
| `packages/core/src/capability/` | `cli-capability` | ✅ **已登记**（实现） |
| `packages/bootstrap/src/capability/` | `cli-capability-bootstrap` | ⏸ **本批不做** —— bootstrap 装配是**内置工具投影**的一部分（O4 未定），CLI 命令面有**自己的组合根**（`packages/cli/src/ocr/index.ts`），不经过 bootstrap ⇒ 登记一个空模块不成立 |
| `packages/cli/src/ocr/` 下的**新文件** | — | ⚠️ `packages/cli/src/ocr/` 已被现有文件覆盖 ⇒ **新增文件**才需登记。✅ 本批新增的 `sidecar-store.ts` 已登记进 `architecture-policy.yaml` 的 `local-infra-unmanaged-files` 例外（`unmanaged-new-file` 规则） |
| 各包的 `tests/` 新文件 | — | 测试目录**不在** `unmanaged-new-file` 规则范围内 |

#### 步 4 的技术未知

⚠️ **第 4 步是本 spec 最大的未知**：数字版 PDF 的「页成分 + 图片位置」目前**没有实现**（`PdfDocumentPort` 只有 `getPageCount` 与 `renderPages`），需要新增 PDF 原生对象分析（文本对象 bbox / 图片对象 bbox）。⇒ 第 4 步开工前要单独确认**技术路线**（poppler 的 `pdftotext -bbox` / `pdfimages`，还是别的），见 §12 O1。⚠️ **O1 的结果语义已由用户定**（没识别出来就是空白页），**待定的是技术路线**。

## 12. 未决问题

| 编号 | 问题 | 阻塞 | 影响 |
| --- | --- | --- | --- |
| **O1** | **数字版 PDF 的版面分析走哪条技术路线？** poppler（`pdftotext -bbox` 给词级 bbox、`pdfimages -list` 给图片对象）+ 自己算 bbox？还是有别的库？⚠️ **结果语义已定**（没识别出来 ⇒ 空白页），**待定的是实现路线** | **步 4** | 决定第 4 步的工作量与跨平台要求（Windows / macOS / Linux 都要有 poppler） |
| **O2** | ~~图片位置对扫描件怎么给？~~ | — | ✅ **已定（2026-11-12）**：**扫描件就是一张图** —— ZCode 为扫描页合成覆盖整页的 image 元素（`bbox = [0,0,1,1]`，`origin: "rendered"`）；页成分按识别到的文字判 `text` / `text+image` / `image` |
| **O3** | ~~sidecar 里的文字放哪？~~ | — | ✅ **已定（2026-11-12）**：**sidecar 放逐元素文字，不放文档级全文**；markdown 正文仍是独立产物（`text.markdownPath`） |
| **O4** | **内置工具投影（`capability-registry.md` §4.4）要不要跟 CLI 积木同批做？** | 步 1 之后 | ⏸ **暂未定**（用户 2026-11-12）。不同批则 agent 侧能力晚于业务侧。⚠️ **v2.1 连带项**：`packages/bootstrap/src/capability/`（D8 的装配位）**随 O4 一起做** —— CLI 命令面有自己的组合根，本批不经过 bootstrap |
| **O5** | ~~进度可见性~~ | — | ✅ **已定（2026-11-12）**：**要进度**。通道与格式见 §5.6（D15）。⚠️ **遗留**：桌面端 / runtime 侧看不到 CLI 积木的进度（那是协议层的另一条链路，不在本 spec 范围） |
| **O6** | **`zcode llm` 族的原子动词与参数**（单次问答？批量？结构化输出？） | 该族实施前 | ⏸ **暂不定**（用户 2026-11-12）。该族无归属 spec，实施前必须补 |
| **O7** | **`contracts/src/capabilities/` 的撞名怎么处置？** 该目录现状是空壳（注释写「provider and model capability descriptions」，`export {}`），[`capability-registry.md`](./capability-registry.md) §11 已把它列为撞名点。**本 spec 的选择是绕开**：新契约放 `contracts/src/capability-blocks/`（D8），旧空壳**不动** | — | 🕐 遗留项：旧空壳的语义（provider / model 能力描述）vs 注册表能力键 vs 积木 id 是**三套**概念，需要一次单独清理；本 spec 只保证不加剧混淆 |

## 13. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| **v1** | **2026-11-12** | 首版：积木模型、族与原子动词、统一信封与退出码、sidecar v1（页成分分类 + 元素位置）、接力（D5）、交付形态。⚠️ 推翻 `capability-registry.md` §4.2 的 `zcode cap run` 统一执行面；修订 `ocr-local.md` §6.5 的交付形态 |
| **v2** | **2026-11-12** | **审查后修订**（详见下方「v2 修订清单」）：统一 sidecar 升 **v3** 并加旧变体映射表（D12）；`key` 定为积木 id 闭集（D13）；运维面单列契约（D14）；加进度通道（D15）；`--pdf-password` 入参（D16）；分类规则改全枚举 + `status` 区分失败页；接力矩阵写死（消除「inspect → parse 必重算」的矛盾）；路径基准写死；架构登记清单补全；补测试落点；同步 6 份 spec 的过期引用 |
| | | ⚠️ **v2 修订清单**：① 统一 sidecar 版本 v1 → **v3**（v1/v2 是两个历史变体，已废止），补 §6.3 字段映射表；② `key` 从「未定义的取值」改为**积木 id 闭集** + 与注册表能力键的关系；③ 运维面（`doctor` / `models download`）单列契约，解决「退出码恒 0」与「unavailable ⇒ 1」的冲突；④ 分类规则补全为 8 行全枚举，页对象加 `status` 区分「失败页」与「空白页」；⑤ 缓存命中判据第 3、4 条写死（档位判据 + 积木所需产物判据）；⑥ 加**接力矩阵**，明确「inspect → parse **不重复调用引擎**」；⑦ sidecar 里的路径基准写死（相对 `artifactsDir`）；⑧ 加 §5.6 进度通道；⑨ 加 §4.3 前置依赖（poppler）；⑩ §11 步 0 补全架构登记清单；⑪ 加 §10.4 测试入口与落点；⑫ 同步旧 spec 引用（§9 表 + 步 6） |
| **v2.1** | **2026-11-12** | **实施步 0–3 后的回写**：① 状态行改为「步 0–3 已实施，步 4 待 O1」；② §5.7 补 `ocr.parse` 的 `output` 形状定稿（`cached` / `sidecarPath` / `artifactsDir` / `artifacts`）；③ §4.1 / §6.2 的默认产物目录名订正为 `<源文件名>.mineru/`（**含扩展名**，与 `local-infra.md` §7.3 一致；原写的「去扩展名」是笔误）；④ §4.1 / §4.2 标注 `--force` / `--pdf-password` 已实施；⑤ §5.6 标注进度通道已实施；⑥ §11 步 0 清单订正为**实际登记的两个模块** + bootstrap 装配随 O4；⑦ §11 表加「状态」列。⚠️ **验收覆盖**：§10.1 全表 ⇒ `@zcode/cli` 的 `tests/ocr-command.test.ts`；§10.2 的分类 / 映射表 / 命中判据 / 接力（**parse → parse**）/ 指纹失效 / `--force` ⇒ `@zcode/core` 的 `tests/capability-ocr-sidecar.test.ts`；MinerU 产物 → 元素模型的提取 ⇒ `@zcode/adapters` 的 `tests/local-infra/document-model.test.ts`。**`inspect` 相关的接力行待步 4** |
| **v2.2** | **2026-11-12** | **加密 PDF 路线落地 + v2.1 失实表述订正**：① ⚠️ **v2.1 说「`--pdf-password` 已实施、hint 与行为对得上」是错的** —— 实测 MinerU 4.1.7 **没有任何密码入口**（`mineru-kit parse <加密.pdf>` 报 `Failed to load document (PDFium: Incorrect password error).`；`mineru-kit parse --help` 无 `--password`；`mineru.parser.parse()` 与 `docvortex.document.pdf.PDFDocument.__init__` 无密码参数）⇒ 密码原先只到得了 poppler 的页数探测，**flag 被接受但对解析没有作用**；② 新路线：**端口在调引擎前探加密状态** —— 未给密码 ⇒ 直接报 `password_protected`（对外 `invalid_input`，hint 指向 `--pdf-password`），**不空跑一次引擎**；给了密码 ⇒ 先用 poppler `pdftocairo -pdf -upw/-opw` 解出**临时无密副本**再交给引擎，解析完即删（原文件不动、指纹仍取原文件）；③ 端口没有 poppler 时走兜底：引擎 stderr 里的 `Incorrect password` 同样归一成 `password_protected`；④ 契约层加 `LocalInfraErrorCode.password_protected` 与 `PdfDocumentPort.decryptToFile`；⑤ §4.3 前置依赖补「加密 PDF 需要 poppler 的 `pdftocairo`」；⑥ ⚠️ **修一个实测暴露的接线 bug**：`--pdf-password` 注册在**全局**旗标表，`run.ts` 的「只服务无头链路」作用域检查会把 `zcode ocr` 一起拦掉（症状：`--pdf-password can only be used with --prompt or --target.`）⇒ `zcode ocr` 命令组豁免该检查（回归见 `packages/cli/tests/pdf-password.test.ts`）。⚠️ **实测留痕**：同一份 PDF 的原文与解密副本分别过 MinerU，**元素模型逐项一致**（块类型 / bbox / `image_source` 全同）⇒ cairo 重编码对 OCR 产物无可见影响（实测结论，非保证）。路线细节见 [`ocr-local.md`](./ocr-local.md) §3.2.1 |
