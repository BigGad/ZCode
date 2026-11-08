import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findExecutableOnPath } from "../context/git-snapshot.js";
import { getWindowsEnvValue } from "../exec/windows-executable.js";
import { MINERU_EXECUTABLE, MINERU_KIT_EXECUTABLE } from "./constants.js";

export type EngineLookupSource = "config" | "path" | "common";

export interface LocatedEngine {
  /** `mineru-kit` 的绝对路径。 */
  readonly path: string;
  readonly source: EngineLookupSource;
  /**
   * 同目录 sibling `mineru`（版本检查用）。
   * ⚠️ `mineru` 与 `mineru-kit` 是**两个不重叠的 CLI**；找不到就是 undefined，不猜。
   */
  readonly versionToolPath?: string;
}

export interface EngineLookupOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** 显式配置的 `mineru-kit` 路径（`ocr.mineruPath`）。 */
  readonly configuredPath?: string;
}

export interface EngineLookupResult {
  readonly engine?: LocatedEngine;
  /** 排查用：按顺序找过哪些位置。 */
  readonly searched: readonly string[];
  readonly reason?: string;
}

/** Windows 下可执行的候选后缀（与 execution adapter 的 spawnable 扩展保持一致）。 */
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"] as const;

/**
 * 定位 `mineru-kit`。
 *
 * 顺序：显式配置 → PATH → 常见安装目录。
 * 显式配置存在但不可用时**直接失败并说明原因**，不再回退到 PATH ——
 * 用户显式指定了路径，静默换掉会让"我配的引擎"变成不可预期的另一个。
 */
export async function locateMineruKit(
  options: EngineLookupOptions = {},
): Promise<EngineLookupResult> {
  const env = options.env ?? process.env;
  const searched: string[] = [];

  if (options.configuredPath !== undefined && options.configuredPath.trim() !== "") {
    const configured = resolve(options.configuredPath.trim());
    searched.push(configured);
    if (await isExecutableFile(configured)) {
      return {
        engine: {
          path: configured,
          source: "config",
          versionToolPath: await findSiblingVersionTool(configured),
        },
        searched,
      };
    }
    return {
      searched,
      reason: `配置的 mineru-kit 路径不存在或不可执行：${configured}`,
    };
  }

  const onPath = await findExecutableOnPath(MINERU_KIT_EXECUTABLE, env);
  if (onPath !== undefined) {
    searched.push(onPath);
    return {
      engine: {
        path: onPath,
        source: "path",
        versionToolPath: await findSiblingVersionTool(onPath),
      },
      searched,
    };
  }

  for (const directory of await commonCandidateDirectories(env, options.cwd)) {
    searched.push(directory);
    const candidate = await resolveExecutableInDirectory(directory, MINERU_KIT_EXECUTABLE);
    if (candidate !== undefined) {
      return {
        engine: {
          path: candidate,
          source: "common",
          versionToolPath: await findSiblingVersionTool(candidate),
        },
        searched,
      };
    }
  }

  return { searched, reason: "PATH 与常见安装目录中都没有找到 mineru-kit" };
}

/** 常见安装目录。uv tool install 的脚本落在 `~/.local/bin`，Windows 下是 `Scripts`。 */
async function commonCandidateDirectories(
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): Promise<string[]> {
  const directories: string[] = [];
  const home = homedir();
  directories.push(join(home, ".local", "bin"));
  directories.push(join(home, ".local", "share", "uv", "tools", "mineru", "bin"));

  if (cwd !== undefined && cwd !== "") {
    directories.push(join(cwd, ".venv", "bin"));
    directories.push(join(cwd, ".venv", "Scripts"));
  }

  if (process.platform === "win32") {
    const localAppData = getWindowsEnvValue(env, "LOCALAPPDATA");
    if (localAppData !== undefined) {
      directories.push(
        ...(await pythonScriptDirectories(join(localAppData, "Programs", "Python"))),
      );
    }
    const appData = getWindowsEnvValue(env, "APPDATA");
    if (appData !== undefined) {
      directories.push(...(await pythonScriptDirectories(join(appData, "Python"))));
    }
  }

  return directories;
}

/** 展开 `Python312` / `Python311` 这类版本目录下的 `Scripts`。 */
async function pythonScriptDirectories(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^Python\d+$/u.test(entry.name))
      .map((entry) => join(parent, entry.name, "Scripts"));
  } catch {
    return [];
  }
}

/** 在指定目录里找可执行文件；Windows 下按后缀展开。 */
async function resolveExecutableInDirectory(
  directory: string,
  name: string,
): Promise<string | undefined> {
  for (const fileName of executableFileNames(name)) {
    const candidate = join(directory, fileName);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** 同目录 sibling `mineru`。找不到返回 undefined —— 不猜路径、不回退到 PATH。 */
async function findSiblingVersionTool(kitPath: string): Promise<string | undefined> {
  const directory = dirname(kitPath);
  for (const fileName of executableFileNames(MINERU_EXECUTABLE)) {
    const candidate = join(directory, fileName);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function executableFileNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  return [name, ...WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${name}${extension}`)];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
