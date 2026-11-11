import type { MineruTier, TierModelStatus } from "@zcode/contracts";
import {
  MINERU_DOWNLOADABLE_TIERS,
  MINERU_TIERS,
  ocrModelsDownloadCommand,
} from "@zcode/contracts";

export interface ModelRepoState {
  readonly repo: string;
  readonly ready: boolean;
  readonly path?: string;
}

export interface ModelsStatus {
  readonly baseDir?: string;
  /** `huggingface` / `modelscope`。 */
  readonly source?: string;
  readonly repos: readonly ModelRepoState[];
  /** 引擎报告的档位 → 需要的仓库。 */
  readonly tierRepos: ReadonlyMap<MineruTier, readonly string[]>;
}

/**
 * 解析 `mineru-kit models show` 的输出。
 *
 * ⚠️ 输出是给终端看的**人类文本**，且路径可能被 rich 折行到下一行
 * （`就绪 \n(/path/to/repo)`），所以按行解析并处理续行。
 */
export function parseModelsShow(stdout: string): ModelsStatus {
  const lines = stdout.split(/\r?\n/u);
  const repos: ModelRepoState[] = [];
  const tierRepos = new Map<MineruTier, string[]>();
  let baseDir: string | undefined;
  let source: string | undefined;
  let section: "repos" | "tiers" | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === "仓库:" || trimmed === "仓库：") {
      section = "repos";
      continue;
    }
    if (trimmed === "模型档位:" || trimmed === "模型档位：") {
      section = "tiers";
      continue;
    }
    if (trimmed === "") continue;

    if (section === "repos") {
      const match = /^(?<repo>\S+):\s*(?<state>就绪|缺失)\s*(?<rest>.*)$/u.exec(trimmed);
      if (match?.groups === undefined) continue;
      let path = stripParenthesized(match.groups.rest);
      if (path === undefined) {
        // 路径被折行到了下一行
        const next = lines[index + 1]?.trim() ?? "";
        const continued = /^\((?<path>.+)\)$/u.exec(next);
        if (continued?.groups !== undefined) {
          path = continued.groups.path;
          index += 1;
        }
      }
      repos.push({
        repo: match.groups.repo,
        ready: match.groups.state === "就绪",
        ...(path !== undefined ? { path } : {}),
      });
      continue;
    }

    if (section === "tiers") {
      const match = /^(?<tier>[A-Za-z0-9_-]+):\s*(?<repos>.+)$/u.exec(trimmed);
      if (match?.groups === undefined) continue;
      const tier = match.groups.tier.toLowerCase() as MineruTier;
      if (!isMineruTier(tier)) continue;
      const tierRepoNames = match.groups.repos
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
      tierRepos.set(tier, tierRepoNames);
      continue;
    }

    const baseDirMatch = /^model\.base_dir:\s*(?<value>.+)$/u.exec(trimmed);
    if (baseDirMatch?.groups !== undefined) {
      baseDir = baseDirMatch.groups.value.trim();
      continue;
    }
    const sourceMatch = /^model\.source:\s*(?<value>.+)$/u.exec(trimmed);
    if (sourceMatch?.groups !== undefined) {
      source = sourceMatch.groups.value.trim();
    }
  }

  return {
    ...(baseDir !== undefined ? { baseDir } : {}),
    ...(source !== undefined ? { source } : {}),
    repos,
    tierRepos,
  };
}

/** 把引擎报告的模型状态转成契约里的档位视图。 */
export function toTierModelStatuses(status: ModelsStatus): TierModelStatus[] {
  return MINERU_TIERS.map((tier) => {
    const requiredRepos = status.tierRepos.get(tier);
    if (requiredRepos === undefined) {
      return { tier, status: "unknown", repos: [] };
    }
    // ⚠️ 「查得到」与「就绪」是两件事：
    // - 查得到但没就绪 ⇒ 引擎**明确报出缺失**（**全新机器**就是这个状态）；
    // - 查不到        ⇒ 状态问不出来（引擎输出被截断 / 该仓库没被列出）。
    // 修复依据（2026-11-11）：原先只要「没有任何仓库就绪」就落成 `unknown`，
    // 于是全新机器上 basic 档被报成 unknown ⇒ 能力供给层判成「问不出来」，
    // **自动备资产永远不触发**。spec：local-infra.md §5.4 的档位状态表。
    const resolved = requiredRepos.map((repoName) => {
      const known = status.repos.find((repo) => repo.repo === repoName);
      return {
        repo: repoName,
        known: known !== undefined,
        ready: known?.ready ?? false,
        path: known?.path,
      };
    });
    const repos = resolved.map((repo) => ({
      repo: repo.repo,
      ready: repo.ready,
      ...(repo.path !== undefined ? { path: repo.path } : {}),
    }));
    const allReady = repos.length > 0 && repos.every((repo) => repo.ready);
    // 引擎明确报出至少一个必需仓库缺失 ⇒ missing（有证据说缺）。
    const anyMissing = resolved.some((repo) => repo.known && !repo.ready);
    const tierStatus = allReady ? "ready" : anyMissing ? "missing" : "unknown";
    return {
      tier,
      status: tierStatus,
      repos,
      // ⚠️ 下载命令只在「确实缺」且档位可下载时给（spec §5.4）：
      // MinerU 的 `models download --tier` 只接受 basic / standard，
      // 给 flash / advanced 编命令 = 编一个用户跑不动的命令。
      ...(tierStatus === "missing" && isDownloadableTier(tier)
        ? { downloadCommand: ocrModelsDownloadCommand(tier) }
        : {}),
    };
  });
}

/** MinerU 只支持这两档的权重下载（实测 `mineru-kit models download --help`）。 */
function isDownloadableTier(tier: MineruTier): boolean {
  return (MINERU_DOWNLOADABLE_TIERS as readonly string[]).includes(tier);
}

function stripParenthesized(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const match = /^\((?<path>.+)\)$/u.exec(trimmed);
  return match?.groups?.path;
}

function isMineruTier(value: string): value is MineruTier {
  return (MINERU_TIERS as readonly string[]).includes(value);
}
