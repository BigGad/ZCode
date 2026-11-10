import type { MineruTier } from "@zcode/contracts";

/**
 * 本地基础设施（spec：docs/design/v2/local-infra.md）常量。
 *
 * ⚠️ MinerU 4.1.7 提供**两个互不重叠的 CLI**：
 * - `mineru-kit` —— 干活的 CLI（parse / hardware / models）。所有解析调用都打这个。
 * - `mineru`    —— Doclib 客户端（parse / read / search / server / config）。只用于版本检查。
 * 二者由同目录 sibling 关系推导，**不要**把 `mineru` 当成 `mineru-kit` 用。
 */
export const MINERU_KIT_EXECUTABLE = "mineru-kit";
export const MINERU_EXECUTABLE = "mineru";

/**
 * 未安装时的安装指引（v1 不代装，只提示）。
 * ⚠️ 定义在 contracts —— core 的就绪投影也要用它兜底（core 不许 import adapters）。
 */
export { MINERU_INSTALL_HINT } from "@zcode/contracts";

export const HARDWARE_DETECT_TIMEOUT_MS = 30_000;
export const VERSION_CHECK_TIMEOUT_MS = 20_000;
export const MODELS_SHOW_TIMEOUT_MS = 60_000;
/** 模型下载要拉 1.2GB 权重，给足时间。 */
export const MODELS_DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

/**
 * 冷启动预算：首次加载模型 + 运行时初始化。
 * 实测首次 parse 显著慢于后续（见 spec §11.0），所以超时必须先留足冷启动再叠页数预算。
 */
export const PARSE_COLD_START_BUDGET_MS = 10 * 60_000;

/** 每档每页秒数（实测均值，见 spec §11.0；仅用于超时预算，不是性能承诺）。 */
export const TIER_SECONDS_PER_PAGE: Record<MineruTier, number> = {
  flash: 5,
  basic: 5,
  standard: 15,
  advanced: 60,
};

/**
 * 档位最低内存要求。
 * ⚠️ **文档核出，未实测**（spec §11.0）。`ceiling` 启发式只看 CPU 核数与加速器，
 * **不查内存/显存**，所以这里是把"显式请求超档"拦下来降级的唯一依据。
 */
export const TIER_MINIMUM_MEMORY_BYTES: Partial<Record<MineruTier, number>> = {
  basic: 2 * 1024 * 1024 * 1024,
  standard: 8 * 1024 * 1024 * 1024,
  advanced: 16 * 1024 * 1024 * 1024,
};

/**
 * 需要剥离的代理环境变量。
 *
 * 原因：SOCKS 代理 + MinerU 的 httpx 会直接失败（`socksio` 未安装）。
 * 解析本身是本地计算，不需要代理；模型下载走 HF/ModelScope，也不吃 shell 代理。
 */
export const PROXY_ENV_KEYS: readonly string[] = [
  "ALL_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "no_proxy",
];

/** 引擎输出目录里约定的产物文件名（仅作兜底，优先按内容分类）。 */
export const ARTIFACT_MARKDOWN_FILENAME = "markdown.md";
