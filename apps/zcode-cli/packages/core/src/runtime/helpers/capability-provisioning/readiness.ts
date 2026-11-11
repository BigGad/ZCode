import {
  MINERU_INSTALL_HINT,
  type LocalInfraDoctorReport,
  type LocalInfraPort,
  type MineruTier,
  type TierModelStatus,
  ocrModelsDownloadCommand,
} from "../../deps.js";
import type { LocalReadinessProjection } from "./types.js";

/**
 * 三层就绪的投影（spec：docs/design/v2/capability-provisioning.md §4 / §8.3）。
 *
 * ⚠️ **不新增端口方法**：就绪状态由 `doctor()` 的报告投影而来
 * （`engines[].available` = ①、`versionToolAvailable` + `version` = ②、
 * `models[].status` + `downloadCommand` = ③）。
 * ⚠️ **就绪状态不得被写进产物或 sidecar**（spec §3）：同一份产物在不同时刻的就绪状态可能不同。
 */

/** 目标引擎（v1 只有 MinerU）。 */
const ENGINE_ID = "mineru";

/**
 * 把 `doctor()` 报告投影成三层就绪状态。
 *
 * ⚠️ **「不可用」与「未就位」必须分开**（spec §4）：
 * - 不可用（①②）⇒ ZCode 不代装第三方可执行文件，给**装法**；
 * - 未就位（③）⇒ 模型仓库没下载，给**下载命令**。
 * 两种「不就位」的下一步不同，不能合并成一句「请先安装 MinerU」。
 */
export function projectLocalReadiness(report: LocalInfraDoctorReport): LocalReadinessProjection {
  const engine = report.engines.find((entry) => entry.engine === ENGINE_ID) ?? report.engines[0];

  // ① 可执行：找不到 mineru-kit ⇒ 不可用。
  if (engine === undefined || !engine.available) {
    return {
      status: "unavailable",
      reason: engine?.reason ?? "未找到本地解析引擎 mineru-kit",
      installCommand: engine?.fix ?? MINERU_INSTALL_HINT,
    };
  }

  // ② 依赖齐：`mineru version --json` 能跑（工具在 + 真的读到了版本）。
  if (!engine.versionToolAvailable || engine.version === undefined) {
    return {
      status: "unavailable",
      reason: engine.versionToolAvailable
        ? "本地解析引擎的版本检查未能通过（依赖不齐）"
        : "未找到本地解析引擎的版本检查工具 mineru",
      installCommand: engine.fix ?? MINERU_INSTALL_HINT,
    };
  }

  // ③ 模型就绪：目标档位的模型仓库已下载。
  const selection = selectTier(report);
  if (selection.status === "ready") {
    return {
      status: "ready",
      ...(selection.tier !== undefined ? { tier: selection.tier } : {}),
      reason:
        selection.tier !== undefined
          ? `本地解析引擎已就绪（档位 ${selection.tier}）。`
          : "本地解析引擎已就绪。",
    };
  }
  if (selection.status === "not-ready") {
    return {
      status: "not-ready",
      ...(selection.tier !== undefined ? { tier: selection.tier } : {}),
      ...(selection.downloadCommand !== undefined
        ? { downloadCommand: selection.downloadCommand }
        : {}),
      reason:
        selection.tier !== undefined
          ? `本地 ${selection.tier} 档模型尚未下载。`
          : "本地模型尚未下载。",
    };
  }
  return {
    status: "unknown",
    ...(selection.tier !== undefined ? { tier: selection.tier } : {}),
    reason: "无法确认本地模型仓库是否就绪。",
  };
}

interface TierSelection {
  readonly status: "ready" | "not-ready" | "unknown";
  readonly tier?: MineruTier;
  readonly downloadCommand?: string;
}

/** 就绪状态的缓存槽（runtime 持有，跨轮复用同一个对象）。 */
export interface LocalInfraReadinessCache {
  current?: {
    readonly turnId: string;
    readonly promise: Promise<LocalReadinessProjection | undefined>;
  };
}

/**
 * 取就绪状态（**任务内缓存**）。
 *
 * ⚠️ 探测会 spawn 子进程（`hardware detect` + `models show`）⇒ 同一轮任务里只付一次
 * （spec §9.2 的硬要求）；**跨轮不缓存** —— 环境会变（沿用 local-infra §6.1）。
 */
export function resolveLocalInfraReadiness(input: {
  readonly cache: LocalInfraReadinessCache;
  readonly turnId: string;
  readonly port: LocalInfraPort | undefined;
}): Promise<LocalReadinessProjection | undefined> {
  const existing = input.cache.current;
  if (existing !== undefined && existing.turnId === input.turnId) return existing.promise;
  const promise =
    input.port === undefined
      ? Promise.resolve(undefined)
      : input.port
          .doctor()
          .then(projectLocalReadiness)
          .catch((error: unknown) => ({
            status: "unknown" as const,
            reason: `本地解析环境体检失败：${error instanceof Error ? error.message : String(error)}`,
          }));
  input.cache.current = { turnId: input.turnId, promise };
  return promise;
}

/**
 * 选档位：**已就绪的档位优先**，其次是「应当下载的那个档位」。
 *
 * ⚠️ 首选 `defaultTier`（MinerU 自己的默认请求档位），其次 `ceilingTier`（本机上限），
 * 最后取报告里第一个就绪的档位。
 * ⚠️ 下载命令给的是 **ZCode 自己的命令**（`zcode ocr models download --tier <t>`），
 * 不是引擎原始命令 —— 用户要在 ZCode 里完成这一步（spec §4）。
 */
function selectTier(report: LocalInfraDoctorReport): TierSelection {
  const models = report.models;
  const ready = models.filter((model) => model.status === "ready");
  const chosen =
    pickReadyTier(ready, report.defaultTier) ??
    pickReadyTier(ready, report.ceilingTier) ??
    ready[0];
  if (chosen !== undefined) {
    return { status: "ready", tier: chosen.tier };
  }

  // 没有就绪档位 ⇒ 找「缺模型且能下载」的档位。
  const missing = models.find(
    (model) => model.status === "missing" && model.tier === report.defaultTier,
  );
  const fallbackMissing = missing ?? models.find((model) => model.status === "missing");
  if (fallbackMissing !== undefined) {
    return {
      status: "not-ready",
      tier: fallbackMissing.tier,
      downloadCommand: downloadCommandFor(fallbackMissing),
    };
  }

  // 模型状态问不出来（`models show` 失败或没有仓库映射）⇒ 不知道，不假装就绪。
  const unknown = models.find((model) => model.tier === report.defaultTier) ?? models[0];
  return { status: "unknown", ...(unknown !== undefined ? { tier: unknown.tier } : {}) };
}

function pickReadyTier(
  ready: readonly TierModelStatus[],
  tier: MineruTier | undefined,
): TierModelStatus | undefined {
  if (tier === undefined) return undefined;
  return ready.find((model) => model.tier === tier);
}

/**
 * 下载命令。
 * ⚠️ **只对 `basic` / `standard` 有意义** —— MinerU 的 `models download --tier` 只接受这两档；
 * 其余档位没有仓库映射，给不出可执行的命令（此时不编命令，交给 `doctor` 说明）。
 */
function downloadCommandFor(model: TierModelStatus): string | undefined {
  if (!isDownloadableTier(model.tier)) return undefined;
  return ocrModelsDownloadCommand(model.tier);
}

/** MinerU 的 `models download --tier` 只接受这两档（实测 `mineru-kit models download --help`）。 */
function isDownloadableTier(tier: MineruTier): boolean {
  return tier === "basic" || tier === "standard";
}
