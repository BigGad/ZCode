// ============================================================
// 能力积木契约 —— 业务侧唯一要解析的东西
// ============================================================

/**
 * 能力积木（capability block）的对外契约。
 *
 * ⚠️ **业务侧只解析这一份信封**（spec：`docs/design/v2/capability-cli-blocks.md` §5）。
 * 业务 spawn `zcode ocr <动词>` 子进程 ⇒ 这份契约**跨进程边界** ⇒ 光有 TypeScript 类型
 * 不够，必须配**运行时可校验的 schema**（见 `schema.ts`）。
 *
 * ⚠️ **信封 `key` 是积木 id，不是注册表能力键**（D13）：取值是**闭集**，业务可以穷举校验。
 * 注册表能力键（`ocr` / `doc.parse` …）是另一套命名空间，见 spec §5.1 的对照表。
 */

/** 信封版本。字段增删或退出码语义变更 ⇒ **递增**并同步业务方（spec §5.3）。 */
export const CAPABILITY_ENVELOPE_VERSION = 1;

/** 积木 id（信封 `key`）闭集（spec §5.1）。新增积木必须同时往本表加一行。 */
export const CAPABILITY_BLOCK_IDS = [
  "ocr.inspect",
  "ocr.parse",
  "ocr.doctor",
  "ocr.models.download",
] as const;

export type CapabilityBlockId = (typeof CAPABILITY_BLOCK_IDS)[number];

/**
 * 对外错误码闭集（8 个，spec §5.2）。
 *
 * ⚠️ 引擎层 / 资产层的细粒度码**一律归一**到这 8 个，原始码放 `details.engineCode`。
 */
export const CAPABILITY_ERROR_CODES = [
  "unsupported_input",
  "invalid_input",
  "unavailable",
  "not_found",
  "permission_denied",
  "cancelled",
  "timeout",
  "internal",
] as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

/** 退出码（spec §5.2）。 */
export const CAPABILITY_EXIT_CODES = {
  ok: 0,
  error: 1,
  timeout: 124,
  cancelled: 130,
} as const;

export type CapabilityExitCode = (typeof CAPABILITY_EXIT_CODES)[keyof typeof CAPABILITY_EXIT_CODES];

/** 失败信封的错误段。`code` 是归一后的能力码，`details.engineCode` 是引擎内部码。 */
export interface CapabilityEnvelopeError {
  readonly code: CapabilityErrorCode;
  /** 中文，可直接给用户看。 */
  readonly message: string;
  /** 可处置提示（装法 / 改法）。 */
  readonly hint?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * 信封的度量段。
 *
 * ⚠️ **降级不是错误**：`degradedFrom` 与 `warnings` 都在这里，不进 `error`（spec §5.4）。
 */
export interface CapabilityEnvelopeMetrics {
  readonly durationMs?: number;
  readonly warnings?: readonly string[];
  readonly degradedFrom?: string;
  readonly [key: string]: unknown;
}

/** 成功信封。`output` 只放**产物引用**，产物本体在磁盘上（spec §5.1）。 */
export interface CapabilitySuccessEnvelope {
  readonly version: number;
  readonly key: CapabilityBlockId;
  readonly ok: true;
  readonly output: Readonly<Record<string, unknown>>;
  readonly metrics?: CapabilityEnvelopeMetrics;
}

/** 失败信封。 */
export interface CapabilityFailureEnvelope {
  readonly version: number;
  readonly key: CapabilityBlockId;
  readonly ok: false;
  readonly error: CapabilityEnvelopeError;
  readonly metrics?: CapabilityEnvelopeMetrics;
}

export type CapabilityEnvelope = CapabilitySuccessEnvelope | CapabilityFailureEnvelope;

/** 进度事件的阶段（spec §5.6）。 */
export const CAPABILITY_PROGRESS_PHASES = ["provision", "analyze", "write"] as const;

export type CapabilityProgressPhase = (typeof CAPABILITY_PROGRESS_PHASES)[number];

/**
 * 进度事件（**走 stderr**，一行一个 NDJSON）。
 *
 * ⚠️ `percent` 可以是 `null` —— 阶段内进度不可知（引擎内部推理）时就是 `null`，
 * 不许拿假百分比糊弄业务。
 */
export interface CapabilityProgressEvent {
  readonly type: "progress";
  readonly phase: CapabilityProgressPhase;
  readonly message: string;
  readonly percent: number | null;
}

// ============================================================
// 产物 sidecar v3（D12）
// ============================================================

/**
 * 统一 sidecar 版本号 = **3**。
 *
 * ⚠️ v1（tesseract 变体）与 v2（MinerU 变体）是**已废止的历史变体**，版本号**不复用**。
 */
export const OCR_SIDECAR_VERSION = 3;

/**
 * 原生分析路线的标识（写进 sidecar 的 `engine.name` / `engine.route`，
 * 也是 `ocr.inspect` / `ocr.parse` 的 `output.engine` 取值）。
 *
 * ⚠️ **定义在 contracts 是因为三方都要用**：adapter 判路线、core 判缓存、
 * 命令面投影输出 —— 三份各写一遍字面量必然漂移。
 */
export const OCR_NATIVE_ANALYSIS_ROUTE = "pdf-native";

/**
 * 原生分析路线的档位名（写进 sidecar 的 `engine.tier`）。
 *
 * ⚠️ **原生路线没有质量档位**（不烧权重）⇒ 用一个固定值占位，
 * 免得业务把 `"native"` 当成某个档位去比较。
 */
export const OCR_NATIVE_ANALYSIS_TIER = "native";

/** 元素分类（spec §6.4）。分类由**映射表**得出，不直接比较 `type` 字符串。 */
export const OCR_ELEMENT_CATEGORIES = ["text", "image", "other"] as const;

export type OcrElementCategory = (typeof OCR_ELEMENT_CATEGORIES)[number];

/** 页成分（spec §6.4 的 8 行全枚举）。 */
export const OCR_PAGE_COMPOSITIONS = ["text", "image", "text+image", "other", "empty"] as const;

export type OcrPageComposition = (typeof OCR_PAGE_COMPOSITIONS)[number];

/** 页状态。`failed` ≠ `empty`（spec §6.4）。 */
export const OCR_PAGE_STATUSES = ["ok", "failed"] as const;

export type OcrPageStatus = (typeof OCR_PAGE_STATUSES)[number];

/**
 * 元素来源。
 *
 * - `"engine"` = 引擎从版面里裁出来的图（bbox 是它在页面上的位置）；
 * - `"rendered"` = ZCode 自己渲染的整页图（扫描页天然「一张图就是一张图」）。
 */
export const OCR_ELEMENT_ORIGINS = ["engine", "rendered"] as const;

export type OcrElementOrigin = (typeof OCR_ELEMENT_ORIGINS)[number];

/**
 * 一个元素。
 *
 * ⚠️ **`type` 是开放字符串**（实测出现过 `text` / `paragraph_title` / `table` / `image` /
 * `chart`，且**类型名随档位变**）⇒ schema 必须允许额外字段。
 */
export interface OcrSidecarElement {
  readonly category: OcrElementCategory;
  readonly type: string;
  readonly origin?: OcrElementOrigin;
  /** 归一化四元组 `[x0, y0, x1, y1]`，分母是页级 `widthPt` / `heightPt`。 */
  readonly bbox: readonly [number, number, number, number];
  /** 文本类元素的内容；图片类元素**不给** `text`。 */
  readonly text?: string;
  /** 相对 `artifactsDir` 的图片路径。 */
  readonly imagePath?: string;
  readonly [key: string]: unknown;
}

/** 一页。 */
export interface OcrSidecarPage {
  /** **0 基**（与 MinerU `page_idx` 一致）。 */
  readonly pageIndex: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly status: OcrPageStatus;
  /** `status = "failed"` 时为 `null`。 */
  readonly composition: OcrPageComposition | null;
  /** 未归类元素计数（`other` 类元素**不污染** composition）。 */
  readonly otherElements: number;
  readonly elements: readonly OcrSidecarElement[];
}

/** 源文件指纹。`sha256` 是**内容指纹**（mtime 会被复制 / 同步工具改）。 */
export interface OcrSidecarSource {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** 引擎信息。引擎差异全部下沉到这里，业务只认统一的字段。 */
export interface OcrSidecarEngine {
  readonly name: string;
  readonly variant: string;
  readonly version: string;
  readonly tier: string;
  readonly route: string;
  readonly assets: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/**
 * 统一 sidecar。
 *
 * ⚠️ **路径基准写死**（spec §6.2）：
 * - `artifactsDir` 相对 **sidecar 所在目录**；
 * - `elements[].imagePath` 相对 **`artifactsDir`**；
 * - `text.markdownPath` 相对 **`artifactsDir`**。
 */
export interface OcrSidecar {
  readonly version: typeof OCR_SIDECAR_VERSION;
  readonly source: OcrSidecarSource;
  readonly engine: OcrSidecarEngine;
  readonly artifactsDir: string;
  readonly pages: readonly OcrSidecarPage[];
  readonly text?: { readonly markdownPath: string };
}
