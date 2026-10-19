import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { IMAGE_EXTENSIONS } from "./image-extensions.js";

/**
 * `zcode recognize` 的文件夹扫描（image-recognition-cli.md「State Owners」节唯一 owner）。
 * 纯 IO + 确定性排序，不持有状态、不调模型。
 */

export interface RecognizeWalkResult {
  /** 绝对路径，按确定性顺序（大小写不敏感的全路径比较）。 */
  images: string[];
  byExtension: Record<string, number>;
}

/**
 * 收集 folder 下（可选递归）的图片文件绝对路径。扩展名大小写不敏感。
 * 非图片被静默过滤，未知/无扩展名的文件不进入 plan。
 */
export async function walkImageFolder(input: {
  folder: string;
  recursive?: boolean;
}): Promise<RecognizeWalkResult> {
  const { folder } = input;
  const recursive = input.recursive === true;

  const images: string[] = [];
  const byExtension: Record<string, number> = {};

  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await visit(fullPath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      const fileStat = await stat(fullPath).catch(() => undefined);
      if (fileStat === undefined || !fileStat.isFile()) continue;
      images.push(resolve(fullPath));
      const key = ext.startsWith(".") ? ext.slice(1) : ext;
      byExtension[key] = (byExtension[key] ?? 0) + 1;
    }
  };

  await visit(resolve(folder));
  images.sort((a, b) => a.localeCompare(b));
  return { images, byExtension };
}