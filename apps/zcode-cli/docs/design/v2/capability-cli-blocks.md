# 能力积木 CLI（业务侧积木模型）

Status: **规划稿**（2026-11-12）：形态已与用户对齐定稿，**代码未实现**。
⚠️ 本 spec **推翻** [`capability-registry.md`](./capability-registry.md) §4.2 的「统一执行面 `zcode cap run` + 不新增子命令路由到每个能力」，并**修订** [`ocr-local.md`](./ocr-local.md) §6.5 的交付形态。冲突处以本 spec 为准。

## 1. 目的与范围

**zcode 的 CLI 就是业务侧要用的积木。** 业务拿一堆原子命令，自己写代码 / 脚本把它们拼成场景逻辑（先干什么后干什么、怎么合并结果、失败怎么重试，全归业务）。

> ⚠️ **场景归业务。** 「律师阅卷」「考生试卷扫描」这类场景差异**不进 zcode** —— zcode 里不出现场景字样。同一份 OCR 原子，被不同场景按不同参数用出不同效果。

本 spec 定义**积木模型本身**：族与原子动词的划分、积木的硬约束、参数契约、统一信封与退出码、产物 sidecar 契约、积木之间的接力与缓存、交付给业务的形式。

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
| **D6** | **统一信封 + 统一退出码**，所有积木一套 | 业务要写**一套**解析器吃所有积木的输出 |
| **D7** | **sidecar 格式归 zcode 定、与引擎无关**；引擎原生产物降级为调试副产物 | 业务一旦直接读 MinerU 的产物格式，换引擎 / 升 MinerU 时业务解析代码全废 |
| **D8** | **包层位走路线 (a) 契约下沉**：契约进 `packages/contracts/src/capabilities/`，实现进 `packages/core/src/capability/`，装配进 `packages/bootstrap/` | 不新增架构层、不改 `architecture.md`；`core → contracts` 合规 |
| **D9** | **页成分给第四态 `empty`**（空白页） | 只给「纯文本 / 纯图片 / 文本+图片」三态时，空白页要靠「没有元素」反推 |
| **D10** | **引擎与 Python 环境由用户自装**；ZCode 只备**权重 / 语言包**等资产 | 沿用 [`local-infra.md`](./local-infra.md) §3.1 |
| **D11** | **自动备资产默认开**（`ocr.autoProvision` 默认 `true`） | 产品承诺是「ZCode 自己把能力拉起来，用户不感知命令」 |

## 3. 积木模型

### 3.1 族与原子动词

**族 = 一个能力域**，组内是**原子动词**（一个动作一个命令）。

| 族 | 域 | 归属 spec | 状态 |
| --- | --- | --- | --- |
| `zcode ocr` | 文档版面 + 文字识别 | [`ocr-local.md`](./ocr-local.md) / [`local-infra.md`](./local-infra.md) | **v1 实现这一族** |
| `zcode llm` | 模型调用 | 无（待写） | ⏸ 无归属 spec，实施前必须补 |
| `zcode asr` | 音频转写 | [`audio-input.md`](./audio-input.md)（覆盖云端附件，不含本地命令组） | ⏸ |
| `zcode asset` | 资产（权重 / 语言包） | [`model-assets.md`](./model-assets.md) | ⏸ 延期（占位地址未换，见 `local-infra.md` §7.3） |

**v1 的 `zcode ocr` 原子动词**

| 动词 | 干什么 | 面 |
| --- | --- | --- |
| `zcode ocr inspect --path <文件>` | 页成分 + 元素位置（**不产出文字**） | **业务积木** |
| `zcode ocr parse --path <文件>` | 文字 / markdown（**顺带带出页成分与位置**） | **业务积木** |
| `zcode ocr doctor [--json]` | 引擎体检（只读，不下载任何权重） | 运维面 |
| `zcode ocr models download --tier <档位>` | 下载档位权重 | 运维面 |

⚠️ **为什么 `inspect` 和 `parse` 是两个积木而不是一个**：按需付费。只需要「这页是纯文本还是纯图片、图和文各在哪」的场合**不该被迫付一次完整识别的代价**（识别 = 权重 + 推理，扫描件上是最贵的一步）。`inspect` 对**数字版 PDF** 走 PDF 原生对象分析（不需要权重），只有扫描件才落到识别路线。

⚠️ **`parse` 的产物是 `inspect` 的超集** —— 一次解析写出的 sidecar 同时含页成分、元素位置与文字。所以业务「先 inspect 再 parse」时，第二次调用命中 sidecar 缓存（§6.4），**不重复识别**。

⚠️ **运维面动词（`doctor` / `models download`）也是 CLI，但不是业务积木** —— 它们对人 / 运维有意义，对业务代码没有。它们与业务积木共用信封与退出码（业务想调也调得动）。

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
| **sidecar 写入原子** | 先写临时文件再 rename（[`ocr-local.md`](./ocr-local.md) §6.1 已定）；同文件并发写时**后者胜**且内容等价，不得出现半截 JSON |
| **同文件并发识别** | 允许重复计算（结果等价），**不做跨进程锁** —— 锁的复杂度与跨平台差异不值得，业务侧重试成本本来就低 |
| **幂等** | 相同输入 + 相同引擎状态 ⇒ 相同产物；重试不产生副作用残留 |

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
| **只用长名旗标** | `-p` 被 `--prompt` 占用（`local-infra.md` M14）；积木命令**不引入短名** |
| **旗标必须在全局表注册** | `packages/cli/src/arguments.ts` 是 `strict: true` 的全局解析器，未注册的旗标在进分派表之前就报「未知参数」 |
| **`--json` 是复用的既有旗标** | 已存在于全局表（`usage` / `plugins` 在用）⇒ **不得重复注册** |
| **输出目录是显式参数** | 产物落在 `--output` 指定的目录；不指定时用 `<源文件名>.mineru/`（现有行为，见 `local-infra.md` §7.3） |
| **旗标只做「哪个积木收哪些」的组合校验** | 旗标语义由积木自己解释；全局表只负责「认不认识」 |

### 4.2 v1 各积木的参数

| 积木 | 参数 | 说明 |
| --- | --- | --- |
| `zcode ocr inspect` | `--path <文件>`（必填）、`--output <目录>`、`--json`、`--force` | 只出页成分 + 元素位置，**不产文字** |
| `zcode ocr parse` | `--path <文件>`（必填）、`--output <目录>`、`--tier <档位>`、`--json`、`--force` | 出文字 + markdown + 页成分 + 位置 |
| `zcode ocr doctor` | `--json` | 只读 |
| `zcode ocr models download` | `--tier <basic\|standard>`（必填）、`--source <auto\|huggingface\|modelscope>`、`--json` | 引擎只接受 basic / standard（实测 `mineru-kit models download --help`） |

⚠️ **`--force` 的语义**：忽略 sidecar 缓存，强制重算并覆盖 sidecar。**默认（不带）命中缓存直接返回**（D5）。⚠️ 这是**破坏性**的（覆盖已有产物）⇒ 破坏性动作在契约里显式命名，不做隐式行为。

⚠️ **不给积木加「批量」旗标**（`--input-dir` 之类）—— D1：批量是业务自己的编排（业务自己循环 / 并发）。zcode 只保证**单个文件**这条路径干净可靠。

## 5. 统一信封与退出码

### 5.1 信封

沿用 [`capability-registry.md`](./capability-registry.md) §8 的信封（**本 spec 只加 `key` 的取值约定，不改形状**）：

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

⚠️ **业务尚未接入 ⇒ 这是零兼容负担的窗口**：迁完就定型。迁的方式：保留 `output` 里那些路径字段（它们正是 §5.1 说的「产物引用」），把 `warnings` 收进 `metrics.warnings`，补 `version` 与 `key`。

## 6. 产物 sidecar 契约

### 6.1 位置与命名

路径：`<源文件目录>/<源文件名>.zcode-ocr.json`（例：`扫描件.pdf.zcode-ocr.json`）。

⚠️ **`<源文件名>` 含扩展名** —— 不是去扩展名的基名（沿用 `ocr-local.md` §6.1 的约定，业务拼路径时别搞错）。

⚠️ **sidecar 是引擎无关的统一格式**（D7）。[`ocr-local.md`](./ocr-local.md) §6.1（tesseract 变体）与 §6.1.1（MinerU 变体）**是引擎内部变体**，最终都归一到本节的统一格式；引擎的差异全部下沉到 `engine` 块里。**业务只认本节这一份。**

### 6.2 统一 sidecar v1

```jsonc
{
  "version": 1,
  "source": { "path": "扫描件.pdf", "sha256": "…", "bytes": 4821003, "mtimeMs": 1762000000000 },
  "engine": {
    "name": "mineru",
    "variant": "mineru",              // 引擎变体名
    "version": "4.1.7",
    "tier": "basic",
    "route": "mineru",                // 内部路线（poppler / mineru / …），业务不依赖
    "assets": {}                      // 用到的资产（语言包 / 权重组）
  },
  "pages": [
    {
      "pageIndex": 0,
      "widthPt": 595.3,
      "heightPt": 841.9,              // ⚠️ bbox 的分母
      "composition": "text+image",    // "text" | "image" | "text+image" | "empty"
      "elements": [
        { "category": "text",  "type": "paragraph_title",
          "bbox": [0.117, 0.086, 0.379, 0.113], "text": "证据材料一" },
        { "category": "image", "type": "image",
          "bbox": [0.300, 0.400, 0.700, 0.720], "imagePath": "images/fig1.jpg" }
      ]
    }
  ],
  "text": { "markdownPath": "markdown.md" }   // 仅 parse 积木产出
}
```

⚠️ **`elements[]` 的 `type` 是开放字符串**（不是封闭枚举）：实测出现过 `text` / `paragraph_title` / `table` / `image` / `chart`，且**类型名随档位变**（standard / flash 叫 `image`，advanced 叫 `chart`）（`local-infra.md` §7 已记）。⇒ schema **必须允许额外字段**。

⚠️ **图片块的 `content` 是空字符串**（图片本体只由 `imagePath` 指向）⇒ `elements[]` 用 `text` 字段（不是 `content`）承载文本类内容，图片类**不给** `text`。

### 6.3 页成分分类规则（写死，不许各写各的）

**判定输入**：`elements[]` 的 `category`。分类由**映射表**得出，**不直接比较 `type` 字符串** —— 因为 `type` 随档位变（D7 / §6.2）。

| `type`（已知值表） | `category` |
| --- | --- |
| `text` / `paragraph_title` | `text` |
| `table` | `text`（表格有内容，是文本） |
| `image` / `chart` | `image` |
| **其它任何值** | `other`（**不计入 text 也不计入 image**） |

**页成分判定**：

| 条件 | `composition` |
| --- | --- |
| 无元素 | `empty`（D9） |
| 只有 `text` 类 | `text` |
| 只有 `image` 类 | `image` |
| `text` 与 `image` 都有 | `text+image` |
| 只有 `other` 类 | `other`（⚠️ **第五态**：引擎出了新类型时不谎报「纯文本」；业务可据此决定重跑或降级） |

⚠️ **未知类型不静默吞掉**：页上额外给 `otherElements` 计数，让业务能看见「有东西我没认出来」。

⚠️ **图片位置 + 文本位置**由 `elements[]` 的 `bbox` 给出（归一化，`[x0,y0,x1,y1]`，分母是 `widthPt` / `heightPt`）。⚠️ **业务换算像素必须自己乘分母** —— zcode 不给像素坐标，因为渲染 DPI 是引擎侧的实现细节。

⚠️ **图片本体已由引擎裁好落盘**（`imagePath`）—— 业务直接拿文件，**不要自己按 bbox 裁**（自己裁会引入 DPI 差异，与 `ocr-local.md` 里 PGM 无 DPI 那个坑同类）。

### 6.4 指纹、失效与接力（D5）

**缓存命中判据**（全部满足才算命中）：

1. sidecar 文件存在且 `version` 是当前版本；
2. `source.sha256` 与当前源文件一致（**内容指纹**，不只是 mtime —— mtime 会被复制 / 同步工具改）；
3. 引擎与档位满足积木的要求（`parse` 要的文字已具备；`inspect` 要的页成分已具备）。

**命中时的行为**：`ok: true`，`output` 里带 `cached: true` 与产物路径，**不重算**。

**未命中**：`ok: true`，`output.cached: false`，`output` 带产物路径。

⚠️ **`--force`**：跳过全部命中判据，强制重算并覆盖 sidecar（D5）。

⚠️ **接力**：业务调 `parse` 时若 `inspect` 已写过 sidecar，则命中缓存、**不重复识别**；反过来业务先调 `parse` 再调 `inspect`，也命中同一份 sidecar。⇒ **业务永远只传原始路径**。

### 6.5 原子写

sidecar 写入必须是「先写临时文件再 rename」（沿用 `ocr-local.md` §6.1），保证并发读者不会看到半截 JSON。

## 7. 积木内部的过程自决

积木**内部**的路线决策归**能力供给层**，规则表见 [`capability-provisioning.md`](./capability-provisioning.md)。本 spec 只补充与积木契约的接口：

| 决策点 | 积木内部行为 | 业务看到 |
| --- | --- | --- |
| 引擎不可用 | 报 `unavailable` + `hint`（装法） | `error.hint` 可直接转给用户 |
| 档位就绪 | 直接用 | 无感 |
| 档位未就位 | **自动备资产**（默认开，D11），或按 `ocr.degradation` 降级 | 降级进 `metrics.warnings`，**不进 `error`**（降级不是错误） |
| 全部路线不可用 | 报 `unavailable` | `error.code` |
| 部分页失败 | **不中断整批**，失败页进 `metrics.warnings` | `ok: true` + warnings |

⚠️ **降级 / 部分成功都不是错误** —— 与 `ocr-local.md` §8 一致：只有「全链都不可用」才是 `unavailable`。

⚠️ **积木的耗时可能到分钟级**（下载 1.2GB 权重 + 识别）。⚠️ **当前只有 runtime 日志可见，桌面端看不到进度** ⇒ 已记为已知缺口，见 §12。

## 8. 交付给业务的形式

| 项 | 规定 |
| --- | --- |
| **部署** | 业务客户端与 zcode **同机**，业务 **spawn 子进程**调积木 |
| **zcode 可执行文件的定位** | **由业务方负责**（配置文件或进程环境变量）。zcode 侧**不新增环境变量** |
| **业务怎么拿错误** | `stderr` 一行 + `exit code` + `--json` 时 stdout 信封。业务可直接把 `error.hint` 转给终端用户 |
| **业务怎么拿产物** | sidecar 文件路径（在 `output` 里）+ 磁盘上的产物 |
| **密码类输入** | 只经 argv 传递，**不落盘、不入日志**（沿用 `pdf-document.port.ts` 约定） |
| **MCP 投影** | 保留（给 dsh 这类 MCP 宿主），但**不是**业务主接入面；见 `capability-registry.md` §4.3 |

⚠️ **子进程路线在批量场景下的成本**：每次调用付一次 node 启动（~200-400ms）+ 一次引擎探测。⚠️ **这是业务自己编排的代价，不是 zcode 的问题**（D1）—— 业务可以在自己的一侧拉一个常驻 worker 复用；zcode 侧不为此设计批量旗标（§3.4）。

## 9. 与既有 spec 的关系

| spec | 关系 |
| --- | --- |
| [`capability-registry.md`](./capability-registry.md) | ⚠️ **§4.2 修订**：投影 A 不再是 `zcode cap run`，改为族命令组（D4）。§3 契约 / §7 退出码 / §8 信封**沿用**。§4.3 MCP 投影保留但降级；§4.4 内置工具投影（agent 自用）不受影响 |
| [`ocr-local.md`](./ocr-local.md) | ⚠️ **§6.5 修订**：交付形态不再写死「子进程调 `zcode cap run ocr`」，改为「子进程调族积木」。§6.1 / §6.1.1 的两个引擎变体 sidecar **归一到本 spec §6.2 的统一格式** |
| [`local-infra.md`](./local-infra.md) | §7.3 的命令组表**沿用**（`zcode ocr` 三个子命令），本 spec 补 `inspect` 积木与 `--force`；§5.4 的档位状态语义不变 |
| [`capability-provisioning.md`](./capability-provisioning.md) | 路线决策规则**沿用**；本 spec 只定义它与积木契约的接口（§7） |
| [`model-assets.md`](./model-assets.md) | `zcode asset` 族延期，占位地址未换（`local-infra.md` §7.3）；本 spec 不动它 |
| [`audio-input.md`](./audio-input.md) | 云端 ASR 附件，不含本地命令组；`zcode asr` 族待写 spec |

## 10. 验收

### 10.1 契约

| 场景 | 断言 |
| --- | --- |
| 信封形状 | 所有积木 `--json` 的 stdout 是**单个** JSON 对象，含 `version` / `key` / `ok`；成功带 `output` + `metrics`，失败带 `error` |
| 退出码 | 逐条对上 §5.2 的表（用假端口注入，不连真引擎） |
| 错误码闭集 | 对外 `error.code` 只取 8 个 `CapabilityErrorCode` 之一；引擎码只出现在 `details.engineCode` |
| 降级不是错误 | 档位降级 / 部分页失败 ⇒ `ok: true` + `metrics.warnings`，退出码 `0` |
| **旧信封已消失** | `zcode ocr parse --json` 不再出现顶层 `warnings` / `engine` / `tier`；`engine` / `tier` 移进 `output` 或 sidecar |

### 10.2 sidecar

| 场景 | 断言 |
| --- | --- |
| 分类正确 | 纯文本页 ⇒ `text`；纯图片页 ⇒ `image`；混合 ⇒ `text+image`；空白页 ⇒ `empty` |
| **档位不改变分类** | 同一份样本在 standard（`image`）与 advanced（`chart`）档下分类**相同** —— 映射表生效，不是字符串直比 |
| 未知类型 | 新块类型 ⇒ `category: "other"`，页成分**不**谎报成 `text`，`otherElements` 计数 > 0 |
| 位置 | `bbox` 是归一化四元组；`widthPt` / `heightPt` 与之一一对应 |
| 图片路径 | `imagePath` 指向的文件真实存在 |
| 格式稳定 | sidecar 里**不出现** MinerU 专有键（`extensions.mineru` / `docvortex_layout`） |
| 原子写 | 并发读 sidecar 永远读到完整 JSON |
| **接力** | `inspect` 后调 `parse` ⇒ `cached: true`，**未重新识别**（断言引擎未被再次调用） |
| **指纹失效** | 源文件内容改动 ⇒ 缓存不命中，重新计算 |
| `--force` | 强制重算并覆盖 sidecar |

### 10.3 积木边界

| 场景 | 断言 |
| --- | --- |
| 自包含 | 每个积木单独调用即完成一件事，不需要前置步骤 |
| 并发 | 多个积木并发跑不互相阻塞、不互相污染产物 |
| 只读面 | `doctor` 不下载任何权重、不写任何产物 |
| 引擎不可用 | `unavailable` + `hint` 给装法；业务可直接把 hint 转给用户 |

## 11. 实施顺序

| 步 | 内容 | 前置 |
| --- | --- | --- |
| 0 | **架构登记**（`contracts/src/capabilities/` 已在 `architecture.md` §2 里，登记为 managed 或逐文件 exception） | — |
| 1 | **统一信封与错误码**：契约进 `contracts/src/capabilities/`；实现进 `core/src/capability/`；装配进 `bootstrap/` | 0 |
| 2 | **迁移 `zcode ocr` 的信封**到统一信封（§5.4） | 1 |
| 3 | **sidecar v1**：统一格式 + 分类规则 + 指纹 + 原子写 + 接力（`--force`） | 2 |
| 4 | **`zcode ocr inspect` 积木**：页成分 + 元素位置（数字版 PDF 走 PDF 原生分析，扫描件落识别路线） | 3 |
| 5 | **`zcode ocr parse` 补齐**产物（文字 / markdown 进同一份 sidecar） | 4 |
| 6 | 契约文档化：`zcode ocr --help` 的族内动词表 + 业务接入说明 | 5 |

⚠️ **第 4 步是本 spec 最大的未知**：数字版 PDF 的「页成分 + 图片位置」目前**没有实现**（`PdfDocumentPort` 只有 `getPageCount` 与 `renderPages`），需要新增 PDF 原生对象分析（文本对象 bbox / 图片对象 bbox）。⇒ 第 4 步开工前要单独确认**技术路线**（poppler 的 `pdftotext -bbox` / `pdfimages`，还是别的），见 §12。

## 12. 未决问题

| 编号 | 问题 | 影响 |
| --- | --- | --- |
| **O1** | **数字版 PDF 的版面分析走哪条技术路线？** poppler（`pdftotext -bbox` 给词级 bbox、`pdfimages -list` 给图片对象）+ 自己算 bbox？还是有别的库？ | 决定第 4 步的工作量与跨平台要求（Windows / macOS / Linux 都要有 poppler） |
| **O2** | **图片位置对扫描件怎么给？** 整页扫描件 = 一张图 ⇒ 位置就是整页？那「文本+图片」的判定要等识别结果 | 决定 `inspect` 在扫描件上的语义 |
| **O3** | **sidecar 里的文字放哪？** 现在 `text` 只放了 `markdownPath`；要不要把全文也进 sidecar？ | 影响 sidecar 体积（大 PDF 的全文可能几 MB） |
| **O4** | **内置工具投影（`capability-registry.md` §4.4）要不要跟 CLI 积木同批做？** | 影响实施顺序；不同批则 agent 侧能力晚于业务侧 |
| **O5** | **进度可见性**：积木耗时可能到分钟级（备权重 + 识别），⚠️ **当前只有 runtime 日志，桌面端看不到** | 业务在同步等一个长命令时无从判断死活 ⇒ 是否要加一个「进度事件」通道（contracts 事件 + 协议 + 桌面渲染）是独立特性 |
| **O6** | **`zcode llm` 族的原子动词与参数**（单次问答？批量？结构化输出？） | 该族无归属 spec，实施前必须补 |

## 13. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| **v1** | **2026-11-12** | 首版：积木模型、族与原子动词、统一信封与退出码、sidecar v1（页成分分类 + 元素位置）、接力（D5）、交付形态。⚠️ 推翻 `capability-registry.md` §4.2 的 `zcode cap run` 统一执行面；修订 `ocr-local.md` §6.5 的交付形态 |
