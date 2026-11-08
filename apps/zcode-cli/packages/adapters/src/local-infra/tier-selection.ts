import type { LocalInfraError, MineruTier } from "@zcode/contracts";
import { MINERU_TIERS } from "@zcode/contracts";
import { TIER_MINIMUM_MEMORY_BYTES } from "./constants.js";

/** 档位从低到高。`pdf_image_tiers` 的数组顺序不保证，用这个排。 */
const TIER_RANK: Record<MineruTier, number> = {
  flash: 0,
  basic: 1,
  standard: 2,
  advanced: 3,
};

export interface HardwareProbe {
  /** 启发式给出的能力上限。⚠️ 只看 CPU 核数与加速器，**不查内存/显存**。 */
  readonly ceiling?: MineruTier;
  /** 本机支持的 PDF/图片解析档位。 */
  readonly pdfImageTiers: readonly MineruTier[];
  /** 引擎建议的默认请求档位。 */
  readonly defaultRequestTier?: MineruTier;
  readonly device?: string;
  readonly calibration?: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

/** 解析 `mineru-kit hardware detect --json` 的 stdout。 */
export function parseHardwareDetect(stdout: string): HardwareProbe | undefined {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  if (parsed === undefined) return undefined;

  const pdfImageTiers = readTierList(parsed.pdf_image_tiers);
  const ceiling = readTier(parsed.ceiling);
  const defaultRequestTier = readTier(parsed.default_request_tier);
  const device = typeof parsed.device === "string" ? parsed.device : undefined;
  const calibration =
    typeof parsed.calibration === "object" && parsed.calibration !== null
      ? (parsed.calibration as Record<string, unknown>)
      : undefined;

  return {
    ...(ceiling !== undefined ? { ceiling } : {}),
    pdfImageTiers,
    ...(defaultRequestTier !== undefined ? { defaultRequestTier } : {}),
    ...(device !== undefined ? { device } : {}),
    ...(calibration !== undefined ? { calibration } : {}),
    raw: parsed,
  };
}

export interface TierDecisionInput {
  readonly requested?: MineruTier;
  readonly hardware?: HardwareProbe;
  /** 机器物理内存。取不到就不做内存降级（不猜）。 */
  readonly systemMemoryBytes?: number;
}

export interface TierDecision {
  /** 最终传给引擎的档位；undefined 表示不传 `--tier`，交给引擎自选。 */
  readonly tier?: MineruTier;
  /** 相对用户请求发生降级时的原档位。 */
  readonly degradedFrom?: MineruTier;
  readonly warnings: readonly string[];
  readonly error?: LocalInfraError;
}

/**
 * 决定实际使用的解析档位。
 *
 * 规则（spec §7.6）：
 * - 用户没指定 → 用引擎建议的默认档位；引擎没建议就用本机支持的最高档。
 * - 用户指定了但本机不支持 → **降级 + 告知**，不硬失败。
 * - 用户指定了但超出该档的内存要求 → 同样降级 + 告知。
 *   （`ceiling` 启发式不查内存，所以这条是唯一的内存闸门。）
 */
export function decideTier(input: TierDecisionInput): TierDecision {
  const warnings: string[] = [];
  const hardware = input.hardware;
  const supported = hardware?.pdfImageTiers ?? [];

  if (input.requested !== undefined && !isMineruTier(input.requested)) {
    // §7.6：档位不在官方枚举内的内部码是 `engine_not_found`（不是 `input_invalid`）。
    return {
      warnings,
      error: {
        code: "engine_not_found",
        message: `未知的解析档位：${String(input.requested)}`,
        hint: `可用档位：${MINERU_TIERS.join("、")}`,
      },
    };
  }

  if (input.requested === undefined) {
    const tier =
      hardware?.defaultRequestTier ?? (supported.length > 0 ? highestTier(supported) : undefined);
    return tier !== undefined ? { tier, warnings } : { warnings };
  }

  const requested = input.requested;
  let target = requested;

  if (supported.length > 0 && !supported.includes(requested)) {
    const fallback =
      hardware?.ceiling !== undefined && supported.includes(hardware.ceiling)
        ? hardware.ceiling
        : highestTier(supported);
    target = fallback;
    warnings.push(
      `档位 ${requested} 在本机不可用（hardware detect 的 pdf_image_tiers 不含），已降级到 ${target}`,
    );
  }

  const memoryWarning = checkMemory(target, input.systemMemoryBytes);
  if (memoryWarning !== undefined) {
    warnings.push(memoryWarning.message);
    if (memoryWarning.degradedTo !== undefined) {
      target = memoryWarning.degradedTo;
    }
  }

  if (target !== requested) {
    // §7.8：降级时产物形状会变（块类型集合、切分粒度、bbox 精度都不同），必须告知。
    warnings.push("产物形状可能与请求档位不同");
    return { tier: target, degradedFrom: requested, warnings };
  }
  return { tier: target, warnings };
}

interface MemoryCheck {
  readonly message: string;
  readonly degradedTo?: MineruTier;
}

/**
 * 内存闸门。内存要求是**文档核出、未实测**的保守值，只在用户显式指定档位时生效，
 * 且只在能取到系统内存时生效——取不到就不猜。
 */
function checkMemory(
  tier: MineruTier,
  systemMemoryBytes: number | undefined,
): MemoryCheck | undefined {
  if (systemMemoryBytes === undefined) return undefined;
  const required = TIER_MINIMUM_MEMORY_BYTES[tier];
  if (required === undefined) return undefined;
  if (systemMemoryBytes >= required) return undefined;

  const candidates = MINERU_TIERS.filter(
    (candidate) =>
      TIER_RANK[candidate] < TIER_RANK[tier] && fitsMemory(candidate, systemMemoryBytes),
  );
  const degradedTo = candidates.length > 0 ? highestTier(candidates) : undefined;
  const requirement = `${Math.round(required / 1024 ** 3)} GiB`;
  const available = `${(systemMemoryBytes / 1024 ** 3).toFixed(1)} GiB`;

  if (degradedTo === undefined) {
    return {
      message: `档位 ${tier} 需要至少 ${requirement} 内存，本机只有 ${available}；已保留请求档位，解析可能失败`,
    };
  }
  return {
    message: `档位 ${tier} 需要至少 ${requirement} 内存，本机只有 ${available}；已降级到 ${degradedTo}`,
    degradedTo,
  };
}

function fitsMemory(tier: MineruTier, systemMemoryBytes: number): boolean {
  const required = TIER_MINIMUM_MEMORY_BYTES[tier];
  if (required === undefined) return true;
  return systemMemoryBytes >= required;
}

function highestTier(tiers: readonly MineruTier[]): MineruTier {
  return [...tiers].sort((left, right) => TIER_RANK[right] - TIER_RANK[left])[0];
}

/**
 * 档位枚举校验。
 *
 * ⚠️ 对外暴露是为了让调用方**在任何 spawn 之前**就能拒绝非法档位
 * （验收 A4：非法档位不得 spawn 子进程）。
 */
export function isMineruTier(value: unknown): value is MineruTier {
  return typeof value === "string" && (MINERU_TIERS as readonly string[]).includes(value);
}

function readTier(value: unknown): MineruTier | undefined {
  return isMineruTier(value) ? value : undefined;
}

function readTierList(value: unknown): MineruTier[] {
  if (!Array.isArray(value)) return [];
  const tiers = value.filter(isMineruTier);
  return [...new Set(tiers)];
}
