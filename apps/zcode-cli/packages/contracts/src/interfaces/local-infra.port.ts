import type { ExecutionPort } from "./execution.port.js";
import type { FileSystemPort } from "./file-system.port.js";
import type { PdfDocumentPort } from "./pdf-document.port.js";

// ============================================================
// Local Infra Port - 本地模型 / 解析基础设施边界
// ============================================================

/** 本地引擎标识。v1 只有 MinerU。 */
export type LocalEngineId = "mineru";

/**
 * 调用方要求的**解析路线**。
 *
 * ⚠️ `"auto"` = **路线自决**（积木层的用法）：文档每页都有文本层 ⇒ 原生分析路线；
 * 否则 ⇒ 识别路线。**业务方不指定路线**（spec：capability-cli-blocks.md §3.1）。
 * ⚠️ 缺省是 `"mineru"` —— runtime 的附件 OCR 一直走识别路线（不改它的行为）。
 */
export type LocalParseRoute = "auto" | "mineru";

/**
 * **实际走的**路线。
 *
 * - `"pdf-native"`：PDF 原生分析（poppler 的 `pdftohtml -xml`）—— 不烧权重；
 * - `"mineru"`：识别路线（MinerU + 权重）。
 */
export type LocalAnalysisRoute = "pdf-native" | "mineru";

/**
 * MinerU 的四档枚举。⚠️ 集合**不能硬编码成三档**：实测
 * `mineru-kit hardware detect --json` 的 `pdf_image_tiers` 是
 * `["flash","basic","standard","advanced"]`，其中 `flash` 官方文档从未出现过。
 * 运行时可用的档位集合要从 `pdf_image_tiers` 动态取，这里的枚举只用于
 * 「用户传入的档位是否合法」这一层校验。
 */
export type MineruTier = "flash" | "basic" | "standard" | "advanced";

export const MINERU_TIERS: readonly MineruTier[] = ["flash", "basic", "standard", "advanced"];

/** 子进程代理策略。`strip` = 剥掉代理变量直连；`inherit` = 原样继承。 */
export type MineruProxyPolicy = "strip" | "inherit";

/**
 * 能力不可用 / 供给失败时的**降级策略**（spec：docs/design/v2/capability-provisioning.md §6）。
 *
 * ⚠️ **「不降级」必须表达成「策略取值 = error」，不能表达成「代码里没有那条路」** ——
 * 否则后期加云端退路就要改协议形状（对外契约版本递增）。
 * ⚠️ v1 **只实现 `error`**；`cloud` 是枚举里的**预留成员**，不是实现 ——
 * 配了 `cloud` 必须**明确报错**，不能悄悄按 `error` 执行（悄悄降级会让用户以为还在本地跑）。
 */
export type DegradationPolicy = "error" | "cloud";

/** 降级策略的取值集合（默认 `error`）。 */
export const DEGRADATION_POLICIES: readonly DegradationPolicy[] = ["error", "cloud"];

/** 默认降级策略：用户没配时的取值。 */
export const DEFAULT_DEGRADATION_POLICY: DegradationPolicy = "error";

/**
 * 未安装本地解析引擎时的装法（用户自己装，ZCode 不代装 —— 见 capability-provisioning.md §4 的 D5）。
 *
 * ⚠️ 定义在 contracts 是因为**两个包都要用**：adapter 用它填 `doctor` 报告的 `fix`，
 * core 的就绪投影用它兜底（core 不许 import adapters）。
 */
export const MINERU_INSTALL_HINT = 'uv tool install --python 3.12 "mineru>=4.0,<5"';

/**
 * 有可执行下载命令的档位（MinerU 的 `models download --tier` **只接受这两档**，
 * 实测 `mineru-kit models download --help`）。
 *
 * ⚠️ 定义在 contracts 是因为**三处都要用**：adapter 决定给不给下载命令、
 * core 的就绪投影给用户的手动命令、CLI 命令面的参数校验 —— 三份各写一遍必然漂移。
 */
export const MINERU_DOWNLOADABLE_TIERS = ["basic", "standard"] as const;

/**
 * 用户在 ZCode 里下载模型权重的命令（**ZCode 自己的命令**，不是引擎原始命令）。
 *
 * ⚠️ 为什么不给 `mineru-kit models download`：引擎可能**不在 PATH 上**（只配了
 * `ocr.mineruPath`），那条命令用户跑不动；而 `zcode ocr models download` 会走
 * 引擎定位、代理剥离与档位校验（spec：local-infra.md §5.4 / §7.9）。
 */
export const OCR_MODELS_DOWNLOAD_COMMAND = "zcode ocr models download";

/** 给用户的手动下载命令（档位 + 子命令拼在一起）。 */
export function ocrModelsDownloadCommand(tier: MineruTier): string {
  return `${OCR_MODELS_DOWNLOAD_COMMAND} --tier ${tier}`;
}

/**
 * 内部错误码（本地基础设施层内部流转）。对外归一由能力层做。
 * ⚠️ 用 `process_failed` 而不是 `engine_failed`——tesseract 路线已有的就是
 * `process_failed`，两个名字指同一件事会让按 `details.engineCode` 分支的业务方漏掉一侧。
 */
export type LocalInfraErrorCode =
  | "engine_not_found"
  | "engine_unavailable"
  | "process_failed"
  | "artifact_missing"
  | "timeout"
  | "input_invalid"
  /**
   * 加密 PDF 的密码被拒（或压根没给）。
   *
   * ⚠️ **引擎认不出这个情形** —— MinerU 4.1.7 没有密码入口，加密 PDF 直接喂进去
   * 只会在 stderr 留一句 `PDFium: Incorrect password error`，从外面看是「引擎崩了」。
   * ⇒ 由 ZCode 侧在调引擎前判定（spec：docs/design/v2/ocr-local.md §3.2.1），
   * 对外归一为 `invalid_input`。
   */
  | "password_protected"
  /**
   * 文档本身损坏（不是有效的 PDF）。
   *
   * ⚠️ 原生分析路线能直接认出这个情形（poppler 的报错比引擎的清楚）⇒ 对外归一为
   * `invalid_input`（**不是** `not_found` —— 文件在，只是坏了）。
   */
  | "document_corrupted"
  /** 没有权限读文件。 */
  | "permission_denied";

export interface LocalInfraError {
  /** 内部码；对外归一由能力层做。 */
  readonly code: LocalInfraErrorCode;
  /** 中文，可直接给用户看。 */
  readonly message: string;
  /** 可处置提示。 */
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
}

/** 引擎定位与代理策略的配置输入（来自 `ocr.*` 配置键）。 */
export interface LocalInfraConfig {
  /**
   * `mineru-kit` 可执行文件的绝对路径（配置键 `ocr.mineruPath`）。
   * ⚠️ **只指向 `mineru-kit`**（干活的那个）；`mineru`（版本检查）由同目录 sibling 推导。
   */
  readonly mineruPath?: string;
  /** 下载子进程的代理策略（配置键 `ocr.mineruProxy`）。 */
  readonly mineruProxy?: MineruProxyPolicy;
}

/**
 * 端口的依赖 —— 由组合根（bootstrap / CLI 入口）注入，与 CapabilityPorts 里的同一个实例。
 * ⚠️ 这里必须注入已有的 ExecutionPort / FileSystemPort，**不许**在实现内部 new 一个：
 * 会出现两个 ExecutionPort 实例，代理策略 / 超时各走一套。
 */
export interface LocalInfraDeps {
  readonly execution: ExecutionPort;
  readonly fileSystem: FileSystemPort;
  /**
   * 配置层解析出的引擎路径与代理策略。不给则只用 PATH 与常见安装位置探测。
   * ⚠️ 配置键的**读取与层级**由配置层负责；端口只负责「拿到路径后怎么用」。
   */
  readonly config?: LocalInfraConfig;
  /**
   * PDF 页数读取（超时预算要用页数）。不给则按 1 页计并在 `warnings[]` 说明。
   * ⚠️ 可选是刻意的：poppler（`pdfinfo`）不是 ZCode 的依赖，缺它不应让解析功能不可用。
   */
  readonly pdf?: PdfDocumentPort;
}

/** 单个引擎的可用性。 */
export interface EngineAvailability {
  readonly engine: LocalEngineId;
  /** 干活的可执行文件（`mineru-kit`）是否定位到。 */
  readonly available: boolean;
  /** 干活的可执行文件绝对路径。 */
  readonly path?: string;
  /** 版本检查工具（`mineru`）是否定位到。它与 `mineru-kit` 是两个不重叠的独立 CLI。 */
  readonly versionToolAvailable: boolean;
  readonly versionToolPath?: string;
  /** `mineru version --json` 读到的版本。 */
  readonly version?: string;
  /** 不可用原因（给用户看的中文）。 */
  readonly reason?: string;
  /** 可处置提示（装法）。 */
  readonly fix?: string;
}

export interface ModelRepoStatus {
  readonly repo: string;
  readonly ready: boolean;
  readonly path?: string;
}

/** 单个档位的模型就绪情况。 */
export interface TierModelStatus {
  readonly tier: MineruTier;
  /** `ready` | `missing` | `unknown`（无仓库映射，如 flash / advanced）。 */
  readonly status: "ready" | "missing" | "unknown";
  readonly repos: readonly ModelRepoStatus[];
  /** 下载命令（`status = "missing"` 时给）。 */
  readonly downloadCommand?: string;
}

/**
 * 环境体检报告。
 * ⚠️ `doctor` 的退出码恒为 0（除非参数非法）：体检报告本身就是结果，
 * 「不可用」是**有效报告**而不是命令失败。
 * ⚠️ `doctor` 只读：不下载权重、不装依赖、不写任何状态。
 */
export interface LocalInfraDoctorReport {
  readonly engines: readonly EngineAvailability[];
  /** 本机档位上限（`hardware detect` 的 `ceiling`）。 */
  readonly ceilingTier?: MineruTier;
  /** 本机支持的档位列表（`pdf_image_tiers`）。 */
  readonly supportedTiers: readonly MineruTier[];
  /** 不指定档位时的默认档位（`default_request_tier`）。 */
  readonly defaultTier?: MineruTier;
  /** 推理设备（`device`；实测本机 `mps`）。 */
  readonly device?: string;
  /** ONNX 标定状态（`calibration`）——解释「为什么 ceiling 比预期低」。 */
  readonly calibration?: Record<string, unknown>;
  /** 每个档位的模型就绪情况。 */
  readonly models: readonly TierModelStatus[];
  /** 本次探测是否下载了权重 —— 恒为 false（doctor 是只读命令）。 */
  readonly weightsFetched: false;
  readonly durationMs: number;
}

/**
 * 文档里的一个元素（**引擎无关**的中间模型）。
 *
 * ⚠️ **不带 `category`** —— 分类规则（`type` → `text` / `image` / `other`）是 zcode 的
 * 统一口径（spec：capability-cli-blocks.md §6.4），由 core 的积木层算；
 * 端口只负责把**引擎的原始类型名**如实带出来。
 */
export interface LocalDocumentElement {
  /** 引擎给的类型名（**开放字符串**，随引擎与档位变化）。 */
  readonly type: string;
  /** 归一化四元组 `[x0, y0, x1, y1]`（分母是页级 `widthPt` / `heightPt`）。 */
  readonly bbox: readonly [number, number, number, number];
  /** 文本类元素的文本内容；图片类元素**没有**文本。 */
  readonly text?: string;
  /** 图片路径，**相对产物目录**（`LocalParseOutput.outputDir`）。 */
  readonly imagePath?: string;
  /**
   * 元素来源：`"engine"` = 引擎从版面里裁出来的图；`"rendered"` = zcode 自己渲染的整页图。
   * 不给按 `"engine"` 处理（引擎产出的元素都是引擎给的）。
   */
  readonly origin?: "engine" | "rendered";
}

/** 文档里的一页。 */
export interface LocalDocumentPage {
  /** **0 基**页号（与 MinerU `page_idx` 一致）。 */
  readonly pageIndex: number;
  /** 页宽（pt）。缺失时为 0 —— 分类不依赖它。 */
  readonly widthPt: number;
  /** 页高（pt）。缺失时为 0。 */
  readonly heightPt: number;
  /** 该页分析成功（**含「没分析出东西」**）还是分析出错。 */
  readonly status: "ok" | "failed";
  readonly elements: readonly LocalDocumentElement[];
}

/** 一份文档的**元素级**模型（积木层据此写 sidecar）。 */
export interface LocalDocumentModel {
  readonly pages: readonly LocalDocumentPage[];
  /** 产物里记录的生产者（引擎名与版本），用于 sidecar 的 `engine` 块。 */
  readonly producer?: {
    readonly name?: string;
    readonly version?: string;
  };
}

export interface LocalParseRequest {
  /** 待解析文件的绝对路径。 */
  readonly path: string;
  /** 产物输出目录；不给则落到源文件旁的 `<源文件名>.mineru/`。 */
  readonly outputDir?: string;
  /** 显式指定档位；不给 = 用 MinerU 的 `default_request_tier`。 */
  readonly tier?: MineruTier;
  /**
   * 要不要回传**元素级文档模型**（`LocalParseOutput.documentModel`）。
   * ⚠️ **默认 false**：模型带全文，体积随正文增长；只有要写 sidecar / 派生文字的调用方才要。
   */
  readonly documentModel?: boolean;
  /**
   * 加密 PDF 的密码。
   * ⚠️ **只经 argv 传递，不落盘、不入日志、不进事件**（同 `pdf-document.port.ts` 的约定）。
   */
  readonly password?: string;
  /**
   * 解析路线；缺省 `"mineru"`。
   * ⚠️ `"auto"` 时端口**自己判定**（原生分析 vs 识别），并把实际路线回填到
   * `LocalParseResult.route`（spec：capability-cli-blocks.md §3.1 / §6.7）。
   */
  readonly route?: LocalParseRoute;
}

export interface LocalParseOutput {
  /** 产物目录。 */
  readonly outputDir: string;
  /** 扫描产物目录得到的实际 markdown 路径。 */
  readonly markdownPath?: string;
  /** 扫描产物目录得到的实际结构化内容路径。 */
  readonly structuredContentPath?: string;
  /** 扫描产物目录得到的实际中间结果路径。 */
  readonly middleJsonPath?: string;
  /**
   * 图片等资源所在的目录（可能不存在）。
   * ⚠️ 必须**落在 markdown 所在目录之内**（同级或其子目录）——markdown 的图片引用是
   * 相对路径（`![](images/page_0_image_0.jpg)`），只搬三个文档文件 = 图片全断。
   * 消费方按 `relative(markdownDir, assetsDir)` 还原目录名再一起搬。
   */
  readonly assetsDir?: string;
  /** 元素级文档模型（请求了 `documentModel` 才有）。 */
  readonly documentModel?: LocalDocumentModel;
}

export interface LocalParseResult {
  readonly ok: boolean;
  readonly engine?: LocalEngineId;
  /**
   * **实际走的**路线（`"auto"` 请求下才有值）。
   * ⚠️ 原生分析路线下 `engine` **不给值**（引擎没参与，这个字段的类型里也只有
   * `"mineru"`）⇒ 要看路线看这个字段，要看引擎名看 `OCR_NATIVE_ANALYSIS_ROUTE`。
   */
  readonly route?: LocalAnalysisRoute;
  /**
   * ⚠️ **从产物回填**（`extensions.mineru.tier`），不是回填请求值：
   * ZCode 传的 `--tier` 可能被 MinerU 内部改写，权威值在产物里。
   */
  readonly tier?: MineruTier;
  /** 发生过降级时的上一档位。 */
  readonly degradedFrom?: MineruTier;
  readonly output?: LocalParseOutput;
  /** 失败时必填。 */
  readonly error?: LocalInfraError;
  /** 人话告警（降级原因等）。 */
  readonly warnings: readonly string[];
  readonly durationMs: number;
  /**
   * 引擎自己的 stdout（人读文本，**不是 JSON**）。
   * ⚠️ 消费方**不得**把它当 JSON 解析 —— 它只能当进度信息写到 stderr（验收 A10）。
   */
  readonly stdout?: string;
}

/** 模型下载请求（只对下载子进程施加代理策略，解析不受影响）。 */
export interface LocalModelsDownloadRequest {
  /** 目标档位。⚠️ MinerU 的 `models download --tier` **只接受 basic / standard**。 */
  readonly tier: "basic" | "standard";
  /** 模型源（默认交给 MinerU 自己判断）。 */
  readonly source?: "auto" | "huggingface" | "modelscope";
  /**
   * 取消信号（第 2 步：自动备资产是阻塞的，用户取消任务时下载必须一起停）。
   *
   * ⚠️ **可选**：命令面（`zcode ocr models download`）不传，runtime 的自动路线传。
   */
  readonly signal?: AbortSignal;
  /**
   * 下载预算（毫秒）。缺省用端口自己的上限（60 分钟）。
   *
   * ⚠️ 只在**调用方明确知道自己在等什么**时覆盖 —— 权重是 0.8–1.2GB 量级。
   */
  readonly timeoutMs?: number;
}

export interface LocalModelsDownloadResult {
  readonly ok: boolean;
  readonly engine?: LocalEngineId;
  readonly tier?: "basic" | "standard";
  readonly error?: LocalInfraError;
  readonly warnings: readonly string[];
  readonly durationMs: number;
  /** 下载子进程的标准输出（MinerU 的人读文本）。 */
  readonly stdout?: string;
}

export interface LocalInfraPort {
  /** 环境体检（只读）。 */
  doctor(options?: { readonly engine?: LocalEngineId }): Promise<LocalInfraDoctorReport>;
  /** 解析一份文档。 */
  parse(request: LocalParseRequest): Promise<LocalParseResult>;
  /** 下载目标档位的模型权重。 */
  downloadModels(request: LocalModelsDownloadRequest): Promise<LocalModelsDownloadResult>;
}
