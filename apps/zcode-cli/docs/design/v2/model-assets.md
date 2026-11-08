# 本地资产（引擎数据 / 语言资产）管理

Status: 规格已定，未实现。

## 1. 目的与范围

**决策（用户已定）**：模型与语言包由 **ZCode 托管** —— 引擎数据和资产都在 ZCode 一侧。业务客户端**不持有任何模型**，也不负责下载、安装、切换或知道路径。

⚠️ **「托管」的边界要说死**：ZCode 托管的是**资产文件**（权重、语言包、配置），**不是别人的可执行文件**。tesseract / poppler 这类**引擎二进制仍由用户自行安装**（brew / apt / Windows 安装包）—— 见 §3 最后一行与 [`ocr-local.md`](./ocr-local.md) §9。本 spec 不负责分发引擎，也不内置引擎二进制。

本 spec 定义「本地资产」的目录布局、获取 / 校验 / 切换机制、CLI 表面，以及与 OCR 能力的衔接。

**v1 范围**：只有 tesseract 语言资产组（`chi_sim` + `eng` + `configs/`）。

**二期候选**（须先有真实扫描件的对比数据，见 §14）：PP-OCR ONNX 权重 + ONNX Runtime 原生二进制。

**术语约定**（跨 spec 统一，见 §2 延伸）

| 词 | 含义 | 例 |
| --- | --- | --- |
| **资产组** | 一个可直接使用的目录（tesseract 的 `--tessdata-dir` 指向它） | `tessdata-zh-en` |
| **语言资产** | 组内的单个 `.traineddata` 文件 | `tessdata.chi_sim`、`tessdata.eng` |
| **配置资产** | 组内的配置目录 | `tessdata.configs` |

⚠️ **「语言包」这个词全文弃用** —— 它在不同文档里同时指「资产组」和「组内成员」，是歧义源。一律写「语言资产（组内成员）」或「tessdata 组」。

**不适用**

- 不管 LLM 模型 —— 走 provider 配置与 model selection（见 [`model-selections.md`](./model-selections.md)）。
- 不管「模型能力位」`MODEL_CAPABILITIES` —— 那是「这个 LLM 能不能吃图片 / 视频」，与本地资产无关。
- 不管能力键（[`capability-registry.md`](./capability-registry.md) §3）—— OCR 是能力，本 spec 是资产。
- 不管 workspace 范围的资源 —— 走 `WorkspaceResourceIndexPort`。
- 不管工具产物 —— 走 `ToolArtifactStorePort`。
- 不管 npm 依赖与插件依赖。
- **不管音视频转写模型（whisper）** —— [`audio-input.md`](./audio-input.md) 当前把它当**外部已安装依赖**（`transcription_engine_unavailable` = 「whisper 未安装」）。是否把它收归本资产层**需另议**，不在 v1 范围。
- **不管引擎二进制本身** —— tesseract / poppler 仍由用户装（见上）。

## 2. 命名边界：为什么叫 asset 不叫 model

ZCode 里「模型」这个词**已经被 LLM 占用**，且不止一处。`capability-registry.md` §2 已经写明「两套命名空间，别混」，本 spec 是同一原则的延伸。

| 概念 | 载体 | 归谁 |
| --- | --- | --- |
| LLM 模型 | provider 配置 / `modelSelections` / `--model-type` | provider 层 |
| 模型能力位 | `MODEL_CAPABILITIES`（`packages/shared/src/model-selection.ts`） | provider 层 |
| 命名模型类型 | `docs/design/v2/model/` 整个目录 | provider 层 |
| **本地资产** | **本 spec** | **ZCode 资产层** |

因此：

- 命令名是 **`zcode asset`**，**不是** `zcode model`。
- 类型名统一 `LocalAsset*` / `AssetId` / `AssetKind`，不出现 `Model*`。
- 目录与文件名用 `assets`，不用 `models`。
- ⚠️ 但**资产里装的可以是模型**（PP-OCR 权重就是模型）—— 「资产」是**角色**（ZCode 托管的、只读的、可切换版本的文件），不是**内容**。不要因为内容是模型就把命令叫 model。

**资产 vs 相邻概念的边界**

| | 作用域 | 生命周期 | 可切换版本 | 谁写 |
| --- | --- | --- | --- | --- |
| 本地资产 | **机器 / 用户**（与 workspace 无关） | 长期驻留 | ✅ | ZCode 资产层 |
| Workspace 资源 | workspace | 随会话产生 | ❌ | 运行时 |
| 工具产物 | workspace | 随工具调用 | ❌ | 工具 |

⚠️ 资产**不进** `WorkspaceResourceIndexPort`（那是 workspace 维度），也不进 `ToolArtifactStorePort`（那是产物）。

## 3. 已验证的运行时事实

以下为本机（macOS arm64）**实测**结论，实现时按这些写，不要重新踩。

| 事实 | 证据 |
| --- | --- |
| **tesseract 支持 `--tessdata-dir <dir>`**（5.5.1；该参数**不在 `--help` 里**但确实生效，可放在 config 名之前的任意位置） | 实测：`tesseract v_clean.png out -l chi_sim+eng --tessdata-dir <dir> tsv` 正常产出 |
| **因此不需要环境变量** —— `TESSDATA_PREFIX` 也能用，但按 AGENTS.md「不新增环境变量」，统一走命令行参数 | 实测两者等效 |
| **指定 `--tessdata-dir` 后，识别结果与系统 tessdata 字节一致**（`cmp` 通过） | 实测 `outBase.tsv` vs `outE.tsv` |
| **`tessdata/configs/` 是必需的**：`tsv` 不是 tesseract 内置配置名，而是 `configs/tsv` 文件提供的 | 实测：缺 `configs/` → `read_params_file: Can't open tsv` |
| **缺 `configs/` 是静默失败**：**退出码 0**、**`<outbase>.tsv` 不存在**、stderr **两行** `read_params_file: Can't open tsv` | 实测 ⚠️ tesseract 会**退回默认文本输出**，仍写出 `<outbase>.txt` → adapter 必须**专门断言 `<outbase>.tsv` 存在且非空**；只看退出码、或只检查「目录里有没有产物文件」都会**误判为成功** |
| 最小可用 tessdata 目录体积：**46MB**（`chi_sim` 42MB + `eng` 4MB + `configs/` 104KB） | 实测 `du -sh` |
| `osd.traineddata` 10.5MB —— **不需要**（我们自己做 deskew，tesseract 的 OSD 对任意角度都报 0，见 `ocr-local.md` §2） | 实测 |
| `snum.traineddata` 8.5MB —— v1 **不需要**（不专门做数字识别） | — |
| `pdf.ttf` —— v1 **不需要**（只出 TSV，不出 PDF） | — |
| **仓库已有两套成熟机制，其范式可参照**：`packages/zcode-server-cli/src/runtime/componentCache.ts`（内容寻址 + sha256 + 安全解压 + 原子 marker + 平台分目标）与 `releaseDownload.ts`（重试退避 + sha256 校验） | 读源码。⚠️ 两者都在 `packages/zcode-server-cli`（**CLI 之外的包**）→ **照抄范式可以，直接 import 不行**（依赖方向）。重试/退避逻辑要写在 CLI 侧的 `HttpClientPort` 之上，不要复制第二遍 |
| **SEA 打包已有「统一依赖源 + 固定 SHA-256 + 缺失即失败」的先例**：`ripgrep` / `bfs` / `ugrep` 都按 `<platform>-<arch>` 从统一源下载并校验 | [`sea-cross-target-packaging.md`](./sea-cross-target-packaging.md) |
| **内网依赖源已是既有概念**：SEA 用到 `native-search-tools/ripgrep-v14.1.1-1` 镜像目录 | 同上 |
| 用户级配置落点是 `~/.zcode/cli/config.json`（`file-config.adapter.ts`，zod schema + diagnostics） | 读源码 |
| tesseract **二进制**仍需用户自行安装（brew / apt）—— ZCode 不管别人的可执行文件 | `ocr-local.md` §9 |

⚠️ **`configs/` 这一条是最容易漏的**：只下 `chi_sim` + `eng` 两个 `.traineddata` 会得到「退出码 0 但没有 TSV」的静默失败，与之前踩过的 `/tmp` 符号链接坑同类。资产清单里**必须包含 `configs/` 这一项**。

## 4. 能力契约

```ts
// apps/zcode-cli/packages/contracts/src/interfaces/local-asset.port.ts

/** 资产种类。data = 纯数据（语言包 / 权重）；runtime = 平台相关的原生运行时。 */
export type LocalAssetKind = "data" | "runtime";

/** 目标平台。data 类资产用 "any"（跨平台共用）；runtime 类必须精确到平台。 */
export type LocalAssetTarget = "any" | "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-arm64" | "win32-x64";

/** 资产标识。点分小写，全局唯一。例："tessdata.chi_sim"、"tessdata.configs"。 */
export type LocalAssetId = string;

/** 资产版本。语义版本串。 */
export type LocalAssetVersion = string;

/**
 * 资产组：必须一起安装、互相兼容的一组资产。
 * 格式：`<族>-<变体>`，小写连字符，**不允许点号**。例："tessdata-zh-en"、"tessdata-ja"。
 * ⚠️ 组 id 是**对外可见**的（CLI 参数 / catalog key / `active.json` 的 key / sidecar 的 `engine.assets` key），
 * 一旦发布不能改。
 */
export type LocalAssetGroupId = string;

export interface LocalAssetDescriptor {
  readonly id: LocalAssetId;
  readonly version: LocalAssetVersion;
  readonly kind: LocalAssetKind;
  readonly target: LocalAssetTarget;
  /** 归档大小（字节）。 */
  readonly bytes: number;
  /** 归档的 sha256（十六进制小写）。下载后必须逐字节校验。 */
  readonly sha256: string;
  /** 归档格式。 */
  readonly archive: "tar.gz" | "zip";
  /**
   * 归档相对于**源 baseUrl** 的路径。缺省时按 `<assetId>-<version>.<ext>` 推导（§8）。
   * 存在的意义是允许归档名与推导规则不一致。
   */
  readonly archivePath?: string;
  /** 解压后的相对路径前缀。 */
  readonly stripPrefix?: string;
  /** 所属资产组。 */
  readonly group: LocalAssetGroupId;
  readonly license: string;
}

export interface LocalAssetGroupDescriptor {
  readonly id: LocalAssetGroupId;
  readonly version: LocalAssetVersion;
  /** 组内成员。安装组 = 安装全部成员。 */
  readonly assets: readonly LocalAssetDescriptor[];
  /** 组内成员的互斥版本约束：资产 id → 允许的版本区间（semver range）。 */
  readonly requires?: Readonly<Record<LocalAssetId, string>>;
}

export interface LocalAssetState {
  readonly descriptor: LocalAssetDescriptor;
  readonly installed: boolean;
  /** 当前激活的版本是否就是本条。 */
  readonly active: boolean;
  /** 已安装时的本地绝对路径（解压后的目录）。 */
  readonly path?: string;
  readonly installedAt?: number;
}

export interface InstallAssetOptions {
  /** 指定版本；缺省取 catalog 里该资产的最新版本。 */
  readonly version?: LocalAssetVersion;
  /** 从本地目录离线安装（不联网）。见 §9。 */
  readonly offlineDir?: string;
  readonly signal?: AbortSignal;
  /** 下载进度回调（0~1）。 */
  readonly onProgress?: (fraction: number) => void;
}

export interface LocalAssetPort {
  /** 列出已安装资产（含未激活的旧版本）。 */
  listInstalled(): Promise<readonly LocalAssetState[]>;
  /** 取资产组描述符。 */
  describeGroup(group: LocalAssetGroupId): Promise<LocalAssetGroupDescriptor | undefined>;
  /**
   * **解析当前激活版本的资产组目录**。
   * - 未安装 / 未激活 → `undefined`
   * - 已激活但组目录被手工删了 → `undefined`（**不得**返回半残目录）
   * - 组目录存在但成员缺失 → `undefined`（组是原子的，见「契约纪律」）
   * 每次调用**必须重读磁盘上的激活指针**，不得缓存（§7）。
   */
  resolveGroup(group: LocalAssetGroupId): Promise<string | undefined>;
  /** **解析当前激活版本的单个资产目录**。未安装 / 未激活返回 undefined。 */
  resolve(id: LocalAssetId): Promise<string | undefined>;
  /** 下载 + 校验 + 解压 + 落盘**单个**资产。不激活。 */
  install(id: LocalAssetId, options?: InstallAssetOptions): Promise<LocalAssetState>;
  /**
   * 下载 + 校验 + 解压**整个组**，并把成员**汇合**成可直接使用的目录（§6 的 `groups/<groupId>/<version>/`）。
   * 组内成员要么全成、要么全不成 —— 任一成员失败则整组不落盘、不产生汇合目录。
   * 不激活。
   */
  installGroup(group: LocalAssetGroupId, options?: InstallGroupOptions): Promise<LocalAssetGroupState>;
  /** 切换激活版本。资产组内的成员必须一起切。 */
  activate(group: LocalAssetGroupId, version?: LocalAssetVersion): Promise<void>;
  /** 移除已安装版本（非激活版本可直接删；激活版本需先切走）。 */
  remove(id: LocalAssetId, version?: LocalAssetVersion): Promise<void>;
  /** 校验已安装资产的完整性（重算 sha256）。 */
  verify(id: LocalAssetId, version?: LocalAssetVersion): Promise<boolean>;
}

/** 组级安装选项。 */
export interface InstallGroupOptions extends InstallAssetOptions {
  /** 组版本；缺省取 catalog 里该组的最新版本。 */
  readonly groupVersion?: LocalAssetVersion;
}

/** 组级安装的结果。 */
export interface LocalAssetGroupState {
  readonly descriptor: LocalAssetGroupDescriptor;
  readonly installed: boolean;
  readonly active: boolean;
  /** 汇合目录的本地绝对路径（已安装时）。 */
  readonly path?: string;
  readonly installedAt?: number;
}

/**
 * 资产层错误码。
 *
 * ⚠️ **本集合不等于 `CapabilityErrorCode`**（`capability-registry.md` §3）。
 * 它**只存在于 `zcode asset` 命令面**；对外的能力信封只允许用能力码，
 * 资产码由**消费方能力层单向归一**（见 `capability-registry.md` §7 的映射表）。
 */
export type LocalAssetErrorCode =
  | "not_found"        // 资产 / 组 / 版本不存在，或未安装
  | "unavailable"      // 依赖缺失（网络失败、磁盘不足、源不可达）
  | "corrupted"        // sha256 不符 / 解压失败 / 路径穿越被拦截
  | "invalid_input"    // 组版本约束不满足、参数非法
  | "cancelled"
  | "timeout";
```

**契约纪律**

- ⚠️ **端口实现不得缓存「激活指针」**。`resolve` / `resolveGroup` 每次调用都必须重读磁盘上的指针文件 —— 这是「切换在调用前生效」的实现基础（§7）。
- `install` / `installGroup` **不激活**。下载与切换是两件事，避免「装了就生效」这种隐式行为。
- **组是原子的**：安装要么全成、要么全不成；激活要么全切、要么全不切；`resolveGroup` 只在组完整时返回目录。**不允许组内成员版本错配**（PP-OCR 权重配错版本 runtime 就是典型错配）。
- ⚠️ **下载的归档视为不可信数据**（AGENTS.md）：解压必须走安全解压 —— 拒绝含 `../` / 绝对路径 / 符号链接逃逸的条目，且**解压到临时目录后再原子 rename 到位**，绝不直接解到最终目录。
- 资产是**只读**的：资产层只写自己的目录，不写工作区。
- ⚠️ **网络 I/O 走统一请求入口**：下载经 `HttpClientPort`（`packages/contracts/src/interfaces/http-client.port.ts` + `packages/adapters/src/http/`），统一管超时 / 重试 / 退避 / 代理 / 证书 / 审计。**不要**在资产层直接 `fetch`。

## 5. CLI 表面

**这是给人 / 运维用的命令，不是 agent 工具** —— 因此它**不进** `CapabilityRegistry`，也**不做** MCP / 内置工具投影（对照 `capability-registry.md` §4 的三投影模型）。资产管理的使用者是人，要的是可发现性和可读输出，不是 JSON 信封。

```
zcode asset list                     # 已安装资产 + 激活标记
zcode asset catalog                  # 可获取的组 / 资产、版本、体积、许可
zcode asset install <group|asset>    # 下载 + 校验 + 解压（不激活）
zcode asset use <group>[@version]    # 切换激活版本
zcode asset remove <asset>[@version]
zcode asset verify <asset>[@version]
zcode asset path <group|asset>       # 打印本地绝对路径（给外部工具用）
zcode asset install --offline <dir>  # 从本地目录离线安装
```

⚠️ **`--offline` 是带值旗标（string），不是布尔**：`options: { offline: { type: "string" } }`。值 = 本地目录。**不要**写成 `zcode asset install --offline <dir>` 里的 `<dir>` 是位置参数 —— 那会让 `install` 的位置参数槽同时承载「组/资产 id」和「目录」两种含义，必须靠旗标有无来猜。

⇒ **`install` 的位置参数与 `--offline` 互斥**，规则写死：

| 输入 | 行为 |
| --- | --- |
| `zcode asset install tessdata-zh-en` | 在线安装组 `tessdata-zh-en` |
| `zcode asset install --offline /tmp/pkgs` | 从本地目录离线安装（目录里的内容由 §6 的清单文件描述） |
| `zcode asset install tessdata-zh-en --offline /tmp/pkgs` | ⚠️ **报错退出**（`1`）—— 两个来源同时给，不猜 |
| `zcode asset install`（既无位置参数也无 `--offline`） | ⚠️ **报错退出**（`1`）+ 用法提示 |

⚠️ 报错必须走**既有的错误出口**（`ctx.stderr.write` + 返回 exit code，**不调 `process.exit`**），照 `memo-command.ts` 的范式。

⚠️ **`<group|asset>` 是两类参数，语义不同**：

| 参数形态 | 例子 | 对应端口方法 | 返回 |
| --- | --- | --- | --- |
| **组 id**（连字符，形如 `tessdata-zh-en`） | `zcode asset path tessdata-zh-en` | `resolveGroup()` | **汇合目录**（tesseract 的 `--tessdata-dir` 指向它） |
| **资产 id**（点分，形如 `tessdata.chi_sim`） | `zcode asset path tessdata.chi_sim` | `resolve()` | 单个资产目录 |

⚠️ 组 id **不允许点号**，资产 id **不允许连字符** —— 两者靠这个区分，不会歧义。

**接入点（既有四件套，缺一不可）**：

1. `apps/zcode-cli/packages/cli/src/asset-command.ts` —— 命令实现（依赖注入 + 返回 exit code，**不调 `process.exit`**），照 `memo-command.ts` 的范式。
2. `apps/zcode-cli/packages/cli/src/arguments.ts` —— 全局 `parseArgs({strict:true})` 里注册 `--offline`（**string 类型**，值 = 本地目录，见上表）及后续需要的旗标。既有注释口径：strict 解析器要求旗标在全局注册，`run.ts` 收集后透传，**不污染其他命令的选项语义**。⚠️ **已核对：当前 50 个全局旗标里没有 `offline`** → 需新增。
3. `apps/zcode-cli/packages/cli/src/run.ts` —— 加 `case "asset"` 分派。
4. help 文案（`zcode --help` 与 `zcode asset --help`）。

⚠️ **不叫 `zcode model`**（§2）。

⚠️ **不做成独立二进制 —— ⚠️ 这一条与用户原话有出入，待用户确认**。用户原话是「我就单独开一个 cli，专门用来切换模型」；本 spec 落成 `zcode asset` **子命令组**（不是独立二进制）。理由：仓库里已有两个包声明 bin 名 `zcode`（`@zcode/cli` 与 `@zcode/server-cli`），再开第三个会加剧冲突；独立 CLI 还要重造参数解析 / 退出码 / i18n / 日志 / 遥测。

**这条取舍没有获得用户确认** —— 实施前必须回到用户确认「子命令组 vs 独立二进制」。**唯一例外**是离线安装器需要独立分发 —— 若将来要做，名字不能叫 `zcode`（如 `zcode-asset-installer`）。

## 6. 存储布局

```
<storageRoot>/cli/assets/
  objects/
    <target>/<assetId>/<sha256>/
      <解压后的内容>
      asset.json          ← marker：id / version / sha256 / bytes / group / installedAt
  groups/
    <groupId>/<version>/
      <成员文件汇合后的实际内容>     ← 例：chi_sim.traineddata + eng.traineddata + configs/
      group.json          ← 组清单：成员 + requires + 组版本
  active.json             ← 激活指针：{ "<groupId>": { "version": "...", "sha256": {...} } }
```

⚠️ **`<storageRoot>/cli/` 是既有约定**（`bootstrap/app/port-wiring.ts` 的 `<storageRoot>/cli/resources/<sha256>[0:16].db`、`knowledge-rag.md` 的 `<storageRoot>/cli/knowledge/`）。资产层**沿用同一根**，不要另起 `<storageRoot>/assets/` —— 两套根会让 bootstrap 装配时在两个地方来回找。

- **两层存储**：`objects/` 是**内容寻址**的原始资产（同一份字节只存一次）；`groups/` 是**按组汇合**的实际目录。
- 为什么要汇合这一层：tessdata 目录必须**同时含有** `chi_sim.traineddata`、`eng.traineddata` 和 `configs/`，tesseract 只认一个目录。消费方拿到的应该是「一个能直接用的目录」，而不是「三个路径要自己拼」。
- **组目录用复制而非符号链接 / 硬链接**：Windows 上符号链接需要管理员权限、硬链接跨设备会失败 → 复制是最稳的。代价是同一份字节在 `objects/` 与 `groups/` 各存一份（v1 只有一组，46MB × 2，可接受）。
- **内容寻址**：`objects/` 目录名是 sha256 → 同版本重复安装幂等；文件损坏能自证；旧版本天然共存（可回退）。
- `<target>`：`kind=data` 用 `any`；`kind=runtime` 用精确平台串（对齐 `componentCache.ts` 已有的 `^(?:darwin|linux|win32)-(?:x64|arm64)$` 校验规则）。
- `active.json` 是**指针**，不是内容 —— 它指向组与版本，`groups/` 提供实体。
- **原子写**：先写临时文件再 `rename`（`componentCache.ts` 已有 `component.json.tmp-<pid>-<ts>` 的范式）。
- ⚠️ 资产目录**在 workspace 之外**（`<storageRoot>` 是机器 / 用户维度）→ 天然满足 §2 的作用域边界，也不污染工作区。

**⚠️ 原子性分四层，每层各自保证**（「原子」不是一句话能盖住的）：

| 层 | 做法 | 保证 |
| --- | --- | --- |
| 下载 | 写到 `*.part` 临时文件，校验 sha256 **通过后**才改名 | 不会把半截文件当成交付物 |
| 解压 | 解到 `<target>/<assetId>/<sha256>.tmp-<pid>-<ts>/`，**成功后才 rename** 成最终目录 | 失败不留半截目录 |
| 汇合（`groups/`） | 汇合到 `groups/<groupId>/<version>.tmp-<pid>-<ts>/`，**成员全部到位后才 rename** | 组要么完整要么不存在 |
| 激活指针（`active.json`） | 写 `active.json.tmp-<pid>-<ts>` 后 `rename` 覆盖 | 读者永远读到完整 JSON，不会读到半截 |

**⚠️ 并发规则**

- **两个进程同时 install 同一资产** → 内容寻址让目标目录名相同 → 谁先 rename 谁赢，后到者发现目录已存在且校验通过 → **视为成功，幂等**（不报错，不重复下载）。
- **两个进程同时切不同版本** → 最后一次 `rename` 生效（**无序**，但不会损坏）。指针是「当前意图」，不是「事务」。
- **两个进程同时 install 同一组** → 汇合目录名相同 → 同上，幂等。
- **正在被使用的资产被 remove** → 激活版本**拒绝删除**（先切走）；非激活版本在 Unix 上 unlink 安全（已打开的 fd 仍可读），在 Windows 上可能因文件占用失败 → 报 `unavailable` 并提示「有进程正在使用」。

**⚠️ 安全解压（下载的归档是不可信数据）**

- 拒绝含 `../`、绝对路径、`~` 开头、或指向目录外的符号链接条目。
- 解压目标路径必须落在临时目录内（用 `path.resolve` 归一后再判断前缀）。
- **解压出来的文件一律不保留可执行位**（`kind=data`）；`kind=runtime` 的可执行位由资产清单显式声明。

## 7. 切换语义与跨进程一致性

**决策（用户已定）**：切换在**调用前生效**。

- `zcode asset use <group>@<version>` = **原子替换 `active.json` 里的指针**，不移动文件、不删除旧版本。
- **端口不缓存指针**（§4）→ 运行中的 agent 进程在**下一次** OCR 调用时就会用新版本，无需重启会话。
- 旧的已安装版本留在 `objects/` 里 → 出问题可以 `zcode asset use <group>@<old>` 立刻回退。
- 切一个组 = 该组所有成员一起切，**要么全成要么全不成**（先校验全部成员已安装且版本满足 `requires`，再原子写指针）。

⚠️ 这条对 OCR adapter 有直接影响：**tessdata 路径不能在装配期（`port-wiring.ts`）解析一次就固定住**，必须在**每次识别前**通过 `LocalAssetPort.resolveGroup("tessdata-zh-en")` 解析。这与「端口实例在装配时创建」的常规做法不同，spec 里必须写死，否则会拿到启动时的旧版本。

⚠️ **必须是 `resolveGroup()`，不是 `resolve()`**。`resolve("tessdata.chi_sim")` 返回的是**单个资产**的目录（内容寻址目录），不是 tessdata 目录 —— 用它会让 tesseract 指向一个缺 `configs/`、缺其它语言的目录，正好命中 [`ocr-local.md`](./ocr-local.md) §2 记录的「**退出码 0、无产物**」静默失败坑。

## 8. 资产源与优先级

**决策（用户已定）**：**配置优先**，官方源作默认值。

- 源配置进**已有的** `config.json`（`~/.zcode/cli/config.json` 用户级 + 项目级），**不新增环境变量**（AGENTS.md：能用配置 / 旗标表达的优先不做环境变量）。

```jsonc
{
  "assets": {
    "sources": [
      { "id": "intranet", "baseUrl": "https://mirror.internal/zcode/assets/" },
      { "id": "official", "baseUrl": "https://cdn.example.com/zcode/assets/" }
    ],
    "catalogUrl": "https://cdn.example.com/zcode/assets/catalog.json"
  }
}
```

**优先级**

1. 项目级 `config.json` 的 `assets` 段
2. 用户级 `~/.zcode/cli/config.json` 的 `assets` 段
3. 内置默认（只有一个官方源 + 官方 catalog 地址）

⚠️ **第 1 条需要改 schema 才成立**。用户级与项目级用的是**两套不同 schema**：`apps/zcode-cli/packages/adapters/src/config/schema.ts:291-314` 里 `ZCodeConfigFileSchema` 是 `.passthrough()`（未知键放行），而项目级的 `projectConfigFileSchema`（`:315-335`）是它的 `.pick({ mcp, hooks, skill, command })` 白名单再 `.strip()`。

后果：**`assets` 不在白名单里 → 项目级 config 的 `assets` 段会被 `.strip()` 静默删掉**（不报错、不进 diagnostics）。不把 `assets` 加进那个 `.pick()` 白名单，上面第 1 条永远读不到，用户级永远赢，而且把 `assets` 拼错成 `asset` 也不会有任何提示。

- `sources` 是**有序**的：按数组顺序查询，第一个命中的源胜出 → 内网源放前面即可覆盖官方源。
- `catalogUrl` 同样可被配置覆盖 → 内网可提供自己的 catalog。
- 源的形态统一是 HTTP 目录 + 一个 `catalog.json`；本地目录形态由 `--offline`（§9）承担，不进配置。

**catalog 格式**

```json
{
  "version": 1,
  "groups": {
    "tessdata-zh-en": {
      "version": "1.0.0",
      "assets": [
        { "id": "tessdata.chi_sim", "version": "4.0.0", "kind": "data", "target": "any",
          "bytes": 44366093, "sha256": "…", "archive": "tar.gz", "archivePath": "tessdata.chi_sim-4.0.0.tar.gz",
          "stripPrefix": "chi_sim.traineddata",
          "group": "tessdata-zh-en", "license": "Apache-2.0" },
        { "id": "tessdata.eng", "version": "4.0.0", "kind": "data", "target": "any",
          "bytes": 4113088, "sha256": "…", "archive": "tar.gz", "archivePath": "tessdata.eng-4.0.0.tar.gz",
          "stripPrefix": "eng.traineddata",
          "group": "tessdata-zh-en", "license": "Apache-2.0" },
        { "id": "tessdata.configs", "version": "4.0.0", "kind": "data", "target": "any",
          "bytes": 106496, "sha256": "…", "archive": "tar.gz", "archivePath": "tessdata.configs-4.0.0.tar.gz",
          "stripPrefix": "configs",
          "group": "tessdata-zh-en", "license": "Apache-2.0" }
      ]
    }
  }
}
```

**归档 URL 的推导规则**（catalog 里不写绝对 URL —— 绝对 URL 绑死了源，换源就得改 catalog）：

```
<源 baseUrl>/<assetId>-<version>.<ext>
例：https://cdn.example.com/zcode/assets/tessdata.chi_sim-4.0.0.tar.gz
```

- `ext` 由 `archive` 字段决定：`tar.gz` → `.tar.gz`，`zip` → `.zip`。
- `archivePath` 是**相对于源 baseUrl 的路径**；写死它的意义是**允许归档名与推导规则不一致**（如上游改了文件名）。两条路径都要支持：优先用 `archivePath`，缺省则按上面的规则推导。
- ⚠️ **线上与离线的文件名规则必须一致** —— 同一份 `catalog.json` 在两种模式下都能用同一个推导规则找到归档（§9）。

⚠️ **catalog 必须由服务端校验**（zod schema + sha256 格式校验），并遵循 `sea-cross-target-packaging.md` 的既有原则：**归档缺失 / 下载失败 / 校验不通过 → 必须失败，不得降级为「用旧版本继续」**。唯一的例外是显式的 `--offline` 安装。

⚠️ **「本地优先」不等于「离线」**：本模块的常态是**联网**拉 catalog 与归档；离线场景走 §9。OCR 与知识检索的「零网络」是那两者的性质，不是本模块的性质。

## 9. 离线安装

内网 / 涉密环境无法联网。**离线安装不是可选项** —— OCR 在这些场景里是主链路。

```
zcode asset install --offline <dir>
```

`<dir>` 里放：

```
<dir>/
  catalog.offline.json          ← 与线上 catalog 同结构（§8）
  tessdata.chi_sim-4.0.0.tar.gz
  tessdata.eng-4.0.0.tar.gz
  tessdata.configs-4.0.0.tar.gz
```

流程：读 `catalog.offline.json` → 逐个校验归档 sha256 → 解压到内容寻址目录 → 写 marker。**校验不过即失败**，不写半截内容。

⚠️ 归档文件名规则必须写进 spec（`<assetId>-<version>.<ext>`），否则离线包与 catalog 对不上。

## 10. 与 OCR 的衔接

`ocr-local.md` 的引擎层接入点：

- OCR adapter 在**每次识别前**调用 `LocalAssetPort.resolveGroup("tessdata-zh-en")` 拿到 tessdata 目录（成员已汇合，含 `configs/`）→ 命令拼装加 **`--tessdata-dir <dir>`**。
- ⚠️ **必须显式带 `--tessdata-dir`**，不能依赖系统 tessdata —— 否则用户机器上装的语言包版本会污染结果，且行为不可复现。
- 未安装 → OCR 返回 `unavailable` + 提示 `zcode asset install tessdata-zh-en`。
- sidecar 的 `engine` 块要记资产版本（§10.1），换语言包版本后 sidecar 不可复用。

### 10.1 sidecar 的资产字段

```json
"engine": {
  "name": "tesseract",
  "version": "5.5.1",
  "languages": ["chi_sim", "eng"],
  "assets": { "tessdata-zh-en": "1.0.0" },
  "dpi": 300,
  "psm": 4,
  "thresholdingMethod": 1,
  "preprocess": { "mode": "auto", "applied": ["deskew"], "skewAngle": 2.01 }
}
```

- `assets` 记**资产组 → 版本**。sidecar 复用判据是 `source.sha256` + `engine` 块整体（`ocr-local.md` §6.1）→ 换了语言包版本，`engine` 块不同 → 旧 sidecar 不复用。**这一条不需要额外机制，是既有规则的自然延伸。**

## 11. 状态所有者

| 状态 / 事件流 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 资产目录布局与内容寻址 | `apps/zcode-cli/packages/adapters/src/local-assets/store.ts` | 照 `packages/zcode-server-cli/src/runtime/componentCache.ts` 的范式（内容寻址 + sha256 + 安全解压 + 原子 marker） |
| 下载 / 重试 / sha256 校验 | `apps/zcode-cli/packages/adapters/src/local-assets/downloader.ts` | ⚠️ **网络走 `HttpClientPort`**（`packages/contracts/src/interfaces/http-client.port.ts` + `packages/adapters/src/http/`），统一管超时 / 重试 / 退避 / 代理 / 证书 / 审计。`releaseDownload.ts` 在 `packages/zcode-server-cli`（CLI 之外的包），**照抄它 = 复制实现**，重试/退避逻辑要自己写第二遍 —— 不要 |
| 安全解压（防路径穿越） | `apps/zcode-cli/packages/adapters/src/local-assets/extract.ts` | 见 §6 的「安全解压」四条 |
| 激活指针（`active.json`） | `apps/zcode-cli/packages/adapters/src/local-assets/active.ts` | 原子写（§6 四层表）；**每次 resolve 重读，不缓存** |
| 资产源的配置解析与优先级 | `apps/zcode-cli/packages/adapters/src/config`（既有 `config.json` schema） | ⚠️ **要改两处 schema**：`ZCodeConfigFileSchema` 加 `assets` 段，**且** `projectConfigFileSchema` 的 `.pick({...})` 白名单必须加 `assets: true` —— 否则项目级 `assets` 被 `.strip()` 静默剥离，§8 的「项目级 > 用户级」永远不生效（且键名拼错也不报错）。见 §8 |
| catalog 的拉取与校验 | `apps/zcode-cli/packages/adapters/src/local-assets/catalog.ts` | zod schema + sha256 格式；拉取走 `HttpClientPort` |
| **CLI 命令与退出码** | `apps/zcode-cli/packages/cli/src/asset-command.ts` | 返回 exit code 给 `run.ts`，**不调 `process.exit`** |
| **「装哪些资产 / 什么时候需要装」** | **消费方能力层**（OCR 能力） | 资产层只提供能力，不做判断 |
| **切换资产版本的时机与意图** | **用户**（经 CLI） | 资产层不主动切换 |

**避免的反模式**

- 不在资产层判断「要不要用这个资产」—— 那是消费方的策略。
- 不把「激活指针」缓存在模块级变量里（§7）。
- 不让资产层写工作区（资产是机器维度的）。
- 不在资产层 spawn 引擎进程 —— 资产层只管文件。
- 不把资产 id 命名成 `model.*`（§2）。

## 12. 错误语义与退出码

| 情形 | 错误码（`LocalAssetErrorCode`） | 退出码 | 说明 |
| --- | --- | --- | --- |
| 资产不存在 / 未安装 | `not_found` | `1` | 提示 `zcode asset install <group>` |
| 下载失败（网络 / 404） | `unavailable` | `1` | 附状态码；不泄露内部源地址到用户可见输出之外 |
| **sha256 校验不通过** | `corrupted` | `1` | **必须失败**，不降级用旧版本（§8） |
| 解压失败 / 路径穿越 | `corrupted` | `1` | 安全解压拦截（§6） |
| 离线包缺文件 / 校验不过 | `corrupted` | `1` | |
| 资产组版本约束不满足 | `invalid_input` | `1` | 提示需要哪些版本 |
| 切换到未安装的版本 | `not_found` | `1` | |
| 磁盘空间不足 | `unavailable` | `1` | 提示所需与可用字节 |
| 用户取消 | `cancelled` | `130` | |
| 超时 | `timeout` | `124` | |

⚠️ **这一组错误码 = `LocalAssetErrorCode`（§4 已定义），只存在于 `zcode asset` 命令面**，不进对外的能力信封。

⚠️ **`ocr-local.md` §8 用的是另一套码**：那张表有**三列**——引擎层码（`OcrEngineErrorCode`）、对外能力码（`CapabilityErrorCode`）、CLI 退出码。**对外只允许用中间那列**；引擎层码一律归一，原始码放 `details.engineCode`。归一映射在 `ocr-local.md` §8 的表里逐行给出，总表见 [`capability-registry.md`](./capability-registry.md) §7。

⚠️ **本 spec 的 `LocalAssetErrorCode` 与上面两套都不同**：它只存在于 `zcode asset` 命令面（§12），**不进能力信封**。资产层报错 → OCR 能力层捕获 → 归一成 `unavailable` / `not_found` 等能力码 → 原始资产码放 `details.assetCode`。**归一方向是单向的：底层 → 能力码。**

⚠️ **归一方向是单向的：底层 → 能力码**。不是「CLI 层把能力码映射成资产码」。资产码 → 能力码的归一由**消费方能力层**完成（OCR 能力层把「资产未安装 / 未激活」归一成 `unavailable`，原始码放 `details.assetCode`）。

## 13. 验收

⚠️ **测试入口按目标包选，不要默认用 `pnpm test:engineering`**。根 `vitest.config.ts` 的 `engineering` project 的 `include` 是 `scripts/engineering-test-files.json` 的**显式清单**，其中 `apps/zcode-cli/**` **0 条** → 对这些包跑 `pnpm test:engineering <file>` 会得到「No test files found」**且不报错**，验收表形同虚设。

| 目标包 | 正确入口 |
| --- | --- |
| `@zcode/adapters`（资产层实现） | `pnpm --dir apps/zcode-cli --filter @zcode/adapters test`（= `vitest tests`） |
| `@zcode/contracts`（端口契约） | `pnpm --dir apps/zcode-cli --filter @zcode/contracts test` |
| `@zcode/cli`（命令表面） | `pnpm --dir apps/zcode-cli --filter @zcode/cli test`（= `node --test` + **package.json 里显式列出的文件**）→ ⚠️ 新测试**必须**把文件加进 `packages/cli/package.json` 的 `scripts.test` 列表，否则不会被跑 |

工程测试覆盖：

| 场景 | 断言 |
| --- | --- |
| 内容寻址 | 同一 sha256 重复安装 → 目录只有一份；二次安装幂等 |
| **并发安装幂等** | 两个实例同时 install 同一资产 → 都成功、目录只有一份、无半截（§6 并发规则） |
| marker 原子写 | 写过程中崩溃 → 不留半截 `asset.json`（临时文件被清） |
| **解压原子性** | 解压中途抛错 → 临时目录被清，**最终目录不存在**（不是半残目录） |
| sha256 校验 | 归档被篡改 → 抛 `corrupted`，**不落盘**、不激活 |
| 解压安全 | 归档含 `../` 条目 → 拒绝，抛 `corrupted` |
| 解压安全 | 归档含绝对路径 / 符号链接逃逸 → 拒绝，抛 `corrupted` |
| 激活指针原子性 | 切换中断 → `active.json` 仍是旧值（不是半截 JSON） |
| **激活指针不缓存** | `resolveGroup()` 之后再切版本 → 下一次 `resolveGroup()` 返回新路径（回归「调用前生效」） |
| **`resolveGroup` 语义** | 已激活但目录被手工删 → 返回 `undefined`（不是半残目录）；组缺成员 → 返回 `undefined` |
| 组安装原子性 | 组内任一成员失败 → **不产生** `groups/<groupId>/<version>/` 目录，抛 `corrupted` |
| 组整体激活 | 组内缺一个成员 → 整组不激活，错误码 `not_found` |
| 组版本约束 | 成员版本不满足 `requires` → 抛 `invalid_input` |
| 移除 | 删非激活版本 → 成功；删激活版本 → 拒绝（提示先切走） |
| 源优先级 | 项目级配置 > 用户级 > 内置默认；`sources` 按序查询 |
| **catalog schema 校验** | 字段缺失 / sha256 非 64 位十六进制 / `archivePath` 与推导规则冲突 → 校验失败（不进入安装流程） |
| **归档 URL 推导** | 无 `archivePath` 时按 `<assetId>-<version>.<ext>` 推导；有 `archivePath` 时优先用它（§8） |
| 离线安装 | 校验通过 → 落盘并可 `resolveGroup`；校验不过 → 抛 `corrupted` |
| CLI 表面 | `list` / `catalog` / `install` / `use` / `remove` / `verify` / `path` 七条命令的 stdout 与退出码 |
| **CLI `path` 的组/资产分流** | `zcode asset path tessdata-zh-en` → 汇合目录（含 `configs/`）；`zcode asset path tessdata.chi_sim` → 单资产目录（§5） |
| CLI 退出码 | 逐条对上 §12 的表 |
| 错误输出 | 失败时 stderr 一行，不打印堆栈 |

**端到端手测**（需要本机装好 tesseract，**不是 CI 门禁**）：

1. `zcode asset install tessdata-zh-en` → 落盘 46MB。
2. `zcode asset path tessdata-zh-en` → 打印目录。
3. `zcode cap run ocr --input ocr-request.json --json`（`ocr-request.json` = `{ "path": "扫描件.pdf" }`）→ 命令行带 `--tessdata-dir`（用 `ps` / 日志确认），识别结果与系统 tessdata **字节一致**。
4. 删掉 `configs/` 那一项再跑 → **必须报错而不是静默返回空**（回归 §3 的静默失败坑）。

## 14. 未决问题

1. **PP-OCR 走不走 ONNX？** 若走，资产层要新增 `kind=runtime` 的条目（ONNX Runtime 原生二进制；实测 `onnxruntime-node` 当前版本 **31~47MB/平台** + ~0.5MB binding，**Windows x64 / arm64 均已提供**），且 OCR 引擎要换、sidecar 的 bbox 从四点八数变四点四数 → 触发对外契约版本递增。**前置条件是先有真实扫描件的对比数据** —— 现有 CER 全部来自合成清晰页，测不出真实件的差距。
2. **资产的清理策略？** 内容寻址目录会累积旧版本。要不要 LRU 自动清理？→ 倾向**不自动删**（用户可能要回退），提供 `zcode asset remove` 与 `zcode asset list` 显示体积，让用户自己决定；但要加一个「总占用」显示。
3. **资产组的版本策略？** 组版本（如 `tessdata-zh-en` 的 `1.0.0`）与成员版本（`chi_sim` 的 `4.0.0`）是两套语义。组版本是「这套组合的发布号」，成员版本是「单个资产的上游版本」。→ 目录结构已按此设计（组清单存 members），但**升级时组版本如何递增**未定（成员变了组版本要不要跟着变？→ 倾向要，否则缓存无法区分组合）。
4. **多语言怎么办？** 现在只有 `chi_sim` + `eng`。要不要支持按需装其它语言（日文、韩文）？→ 倾向支持，catalog 里加条目即可，组变成 `tessdata-ja` / `tessdata-ko`（**保持 `tessdata-` 前缀**，见 §4 的组 id 格式约定）；但 v1 不做。
5. **资产的许可标注**：catalog 里每条都有 `license`。要不要在 `zcode asset catalog` 里显式展示并要求确认（GPL 类模型要提示）？→ 倾向展示；`tessdata` 是 Apache-2.0，无强制确认。
6. **离线安装器要不要独立成二进制？** 见 §5 的例外条款。
7. ⚠️ **`zcode asset` 是子命令组还是独立二进制？** 见 §5 的标注 —— **用户原话是「单独开一个 cli」，本 spec 落成了子命令组，这个取舍尚未获用户确认**。实施前必须回去确认。
8. **`kind=runtime` 资产的 macOS 隔离问题**（二期相关）：下载的二进制会带 `com.apple.quarantine` 属性 → macOS Gatekeeper 可能拒绝执行。v1 只有 `kind=data`（纯数据文件，不受影响）；做 runtime 资产时需要显式 `xattr -d com.apple.quarantine` 或改用不带隔离属性的分发方式。

## 15. 安装与切换的 owner / 事件顺序图

AGENTS.md 要求「涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序」。本模块的跨进程状态（激活指针）必须画清楚：

```
   用户                        进程 A（运行中的 agent）              进程 B（zcode asset use）
     │                                │                                      │
     │ ① zcode asset install <group>  │                                      │
     ▼                                │                                      │
 ┌──────────┐                         │                                      │
 │ CLI 命令 │ ② 下载 → 校验 sha256 → 解压到临时目录 → rename → 汇合 → rename │
 │  (asset- │ ────────────────────────────────────────────────────────────▶ │
 │  command)│ ③ 落盘完成（**不激活**）                                     │
 └──────────┘                         │                                      │
      │                                │                                      │
      │ ④ zcode asset use <group>@v    │                                      │
      ▼                                │                                      │
 ┌──────────┐                         │                                      │
 │ CLI 命令 │ ⑤ 校验组成员齐全 + requires 满足                              │
 │          │ ────────────────────────────────────────────────────────────▶ │
 │          │ ⑥ 写 active.json.tmp → rename（原子）                          │
 └──────────┘                         │                                      │
                                       │ ⑦ 下次识别前 resolveGroup()          │
                                       │    → **重读** active.json → 拿到 v    │
                                       │    → 命令拼装 --tessdata-dir <v 目录> │
                                       ▼                                      │
                                  tesseract 子进程（只读该目录）
```

**关键点**

- ② 与 ⑤⑥ 之间**没有锁**：两个进程同时操作是安全的，因为每次落盘都是「写临时 → rename」，且内容寻址让重复安装幂等（§6）。
- ⑦ 是**唯一**读取激活指针的地方，且**每次识别前都读** —— 这是「切换在调用前生效」的全部实现。
- **切换不删除旧版本** → 随时可 `use <group>@<old>` 回退。
- 运行中的进程**不会**被切换影响：它每次都重读，已经启动的 tesseract 子进程仍用旧目录（该子进程结束后才生效）—— 这正是「调用前生效」的语义边界。
