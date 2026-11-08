import type { MineruTier, TierModelStatus } from "@zcode/contracts";
import { MINERU_TIERS } from "@zcode/contracts";
import { MINERU_KIT_EXECUTABLE } from "./constants.js";

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
    const repos = requiredRepos.map((repoName) => {
      const known = status.repos.find((repo) => repo.repo === repoName);
      return {
        repo: repoName,
        ready: known?.ready ?? false,
        ...(known?.path !== undefined ? { path: known.path } : {}),
      };
    });
    const allReady = repos.length > 0 && repos.every((repo) => repo.ready);
    const anyReady = repos.some((repo) => repo.ready);
    const tierStatus = allReady ? "ready" : anyReady ? "missing" : "unknown";
    return {
      tier,
      status: tierStatus,
      repos,
      ...(tierStatus === "ready"
        ? {}
        : { downloadCommand: `${MINERU_KIT_EXECUTABLE} models download --tier ${tier}` }),
    };
  });
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
