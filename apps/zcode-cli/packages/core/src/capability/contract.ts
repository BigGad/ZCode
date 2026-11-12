// ============================================================
// 能力积木层契约 —— 纯逻辑，无 IO
// ============================================================

import type {
  LocalDocumentPage,
  OcrPageComposition,
  OcrSidecar,
  OcrSidecarEngine,
  OcrSidecarSource,
} from "@zcode/contracts";

/**
 * 写 sidecar 的输入。
 *
 * ⚠️ **层里不碰文件系统** —— 读产物、算指纹、落盘都是调用方（命令面 / adapter）的事；
 * 这一层只把「已经读好的东西」变成 sidecar。
 */
export interface OcrSidecarBuildInput {
  /** 源文件指纹（内容 sha256 + 大小 + mtime）。 */
  readonly source: OcrSidecarSource;
  /** 引擎信息（引擎差异全部下沉到这里）。 */
  readonly engine: OcrSidecarEngine;
  /** 产物根目录，**相对 sidecar 所在目录**。 */
  readonly artifactsDir: string;
  /** 引擎无关的页模型（端口给的原始类型名，分类由本层算）。 */
  readonly pages: readonly LocalDocumentPage[];
  /** markdown 产物路径，**相对 `artifactsDir`**。 */
  readonly markdownPath?: string;
}

/**
 * 缓存命中判据（spec：capability-cli-blocks.md §6.5）。
 *
 * ⚠️ **四条判据全满足才算命中**，缺一条就重算并覆盖 sidecar。
 */
export interface OcrSidecarCacheCriteria {
  /** 源文件的**内容**指纹（mtime 会被复制 / 同步工具改，不能用）。 */
  readonly sourceSha256: string;
  /** 请求的档位；不给 = 命中任意档位（但要提示实际档位）。 */
  readonly tier?: string;
  /** 是否需要逐元素文字（`parse` 需要，`inspect` 不需要）。 */
  readonly needsText: boolean;
}

/** 缓存判定的结果。 */
export interface OcrSidecarCacheDecision {
  readonly hit: boolean;
  /** 未命中的原因（人话，进 `metrics.warnings`）。 */
  readonly reason?: string;
  /** sidecar 里的档位 —— 命中与否都给，业务看得见实际用的哪一档。 */
  readonly tier?: string;
}

/** 页成分判定结果。 */
export interface OcrPageCompositionResult {
  readonly composition: OcrPageComposition;
  /** 未归类元素计数（**不污染** composition）。 */
  readonly otherElements: number;
}

/** sidecar 的落盘位置。 */
export interface OcrSidecarLocation {
  /** sidecar 的绝对路径。 */
  readonly path: string;
  /** sidecar 所在目录（`artifactsDir` 的基准）。 */
  readonly directory: string;
}

/** 积木层对外的能力：一个 sidecar 命中与否。 */
export interface OcrSidecarResolver {
  resolve(criteria: OcrSidecarCacheCriteria): OcrSidecarCacheDecision;
  readonly sidecar?: OcrSidecar;
}
