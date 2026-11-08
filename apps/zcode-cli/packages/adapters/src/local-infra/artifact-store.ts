import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { MineruTier } from "@zcode/contracts";

/** 单个 JSON 产物的解析上限。middle_json 可能很大，超限就跳过而不是把内存吃光。 */
const MAX_JSON_BYTES = 32 * 1024 * 1024;

export interface ArtifactScan {
  readonly markdownPath?: string;
  readonly structuredContentPath?: string;
  readonly middleJsonPath?: string;
  /**
   * 图片等附件所在目录。
   * ⚠️ 必须是 `markdown.md` 的**同级目录**（同一父目录），否则 markdown 里的相对图片链接会断。
   */
  readonly assetsDir?: string;
  /** 产物里记录的权威档位（`extensions.mineru.tier`）。 */
  readonly tier?: MineruTier;
}

/** 清空并重建输出目录。 */
export async function prepareOutputDir(outputDir: string): Promise<void> {
  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });
}

/**
 * 扫描解包后的产物目录。
 *
 * ⚠️ **按内容分类，不按文件名**：`structured_content.json` / `middle_json.json`
 * 这些名字在 MinerU 版本间会漂（spec §11.0），靠文件名认会随时失效。
 */
export async function scanArtifacts(outputDir: string): Promise<ArtifactScan> {
  const root = resolve(outputDir);
  const files = await collectFiles(root);

  const markdown = pickMarkdown(files);
  const jsonFiles = files.filter((file) => extname(file.relativePath).toLowerCase() === ".json");
  const assetFiles = files.filter((file) => {
    const extension = extname(file.relativePath).toLowerCase();
    return extension !== ".json" && extension !== ".md";
  });

  const classified = await classifyJsonArtifacts(jsonFiles);
  const structured = classified.structured[0];
  const middle = classified.middle[0];
  const tier =
    (structured !== undefined ? await readTierFromStructuredContent(structured) : undefined) ??
    (middle !== undefined ? await readTierFromStructuredContent(middle) : undefined);
  const assetsDir = commonParentDirectory(assetFiles.map((file) => file.absolutePath));

  return {
    ...(markdown !== undefined ? { markdownPath: markdown } : {}),
    ...(structured !== undefined ? { structuredContentPath: structured } : {}),
    ...(middle !== undefined ? { middleJsonPath: middle } : {}),
    ...(assetsDir !== undefined ? { assetsDir } : {}),
    ...(tier !== undefined ? { tier } : {}),
  };
}

/** 从 `structured_content.json` 读 `extensions.mineru.tier`。 */
export async function readTierFromStructuredContent(
  structuredContentPath: string,
): Promise<MineruTier | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(structuredContentPath, "utf8"));
  } catch {
    return undefined;
  }
  return readTierFromValue(parsed);
}

/** 从已解析的 JSON 值里读 `extensions.mineru.tier`。 */
export function readTierFromValue(value: unknown): MineruTier | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const extensions = (value as Record<string, unknown>).extensions;
  if (typeof extensions !== "object" || extensions === null) return undefined;
  const mineru = (extensions as Record<string, unknown>).mineru;
  if (typeof mineru !== "object" || mineru === null) return undefined;
  const tier = (mineru as Record<string, unknown>).tier;
  return typeof tier === "string" ? (tier as MineruTier) : undefined;
}

interface ArtifactFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
}

async function collectFiles(root: string, current: string = root): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) continue;
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(absolutePath)).size;
    } catch {
      continue;
    }
    files.push({ absolutePath, relativePath: relative(root, absolutePath), sizeBytes });
  }
  return files;
}

/** markdown 取最浅的那个；同深度时优先叫 `markdown.md` 的。 */
function pickMarkdown(files: readonly ArtifactFile[]): string | undefined {
  const candidates = files.filter((file) => extname(file.relativePath).toLowerCase() === ".md");
  if (candidates.length === 0) return undefined;
  const depth = (file: ArtifactFile): number => file.relativePath.split(sep).length;
  const sorted = [...candidates].sort((left, right) => {
    const byDepth = depth(left) - depth(right);
    if (byDepth !== 0) return byDepth;
    const leftNamed = basename(left.relativePath) === "markdown.md" ? 0 : 1;
    const rightNamed = basename(right.relativePath) === "markdown.md" ? 0 : 1;
    return leftNamed - rightNamed;
  });
  return sorted[0]?.absolutePath;
}

interface ClassifiedJson {
  readonly structured: string[];
  readonly middle: string[];
  readonly unknown: string[];
}

/**
 * 区分 `structured_content.json` 与 `middle_json.json`。
 *
 * ⚠️ **实测（4.1.7）：两者同形** —— 顶层都是 `pages`，页内都是 `pages[].blocks`，
 * 连 `extensions.mineru.tier` 都一样。所以"顶层有 pages 数组"**区分不了**。
 * 真正的判别是 `middle_json` 顶层独有的 `schema: "docvortex.middle"` / `schema_version`。
 * 2.x 的中间结果是顶层 `pdf_info`，一并当作 middle 判据。
 */
async function classifyJsonArtifacts(files: readonly ArtifactFile[]): Promise<ClassifiedJson> {
  const structured: string[] = [];
  const middle: string[] = [];
  const unknown: string[] = [];

  for (const file of files) {
    if (file.sizeBytes > MAX_JSON_BYTES) {
      unknown.push(file.absolutePath);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file.absolutePath, "utf8"));
    } catch {
      unknown.push(file.absolutePath);
      continue;
    }
    if (isMiddleJson(parsed)) {
      middle.push(file.absolutePath);
      continue;
    }
    if (isStructuredContent(parsed)) {
      structured.push(file.absolutePath);
      continue;
    }
    unknown.push(file.absolutePath);
  }

  // 结构化产物没认出来时，把认不出的那个当作 structured —— 那是用户真正要的产物；
  // 认错的后果只是取不到 tier，不会报错。
  if (structured.length === 0 && unknown.length > 0) {
    structured.push(preferNamed(unknown, "structured")[0]);
    unknown.splice(unknown.indexOf(structured[0]), 1);
  }

  return {
    structured: preferNamed(structured, "structured"),
    middle: preferNamed(middle, "middle"),
    unknown: preferNamed(unknown, "middle"),
  };
}

/** middle 判据：`schema` / `schema_version`（4.x）或 `pdf_info`（2.x）。 */
function isMiddleJson(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.schema === "string") return true;
  if (record.schema_version !== undefined) return true;
  return record.pdf_info !== undefined;
}

/** structured 判据：顶层有 `pages` 数组。 */
function isStructuredContent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as Record<string, unknown>).pages);
}

/** 同类里优先挑文件名带关键字的（只作同类内的次级判据）。 */
function preferNamed(paths: readonly string[], keyword: string): string[] {
  const named = paths.filter((path) => basename(path).toLowerCase().includes(keyword));
  const rest = paths.filter((path) => !named.includes(path));
  return [...named, ...rest];
}

/** 一组路径的最深公共父目录。 */
function commonParentDirectory(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const segmentLists = paths.map((path) => dirname(path).split(sep));
  let common = segmentLists[0];
  for (const segments of segmentLists.slice(1)) {
    let index = 0;
    while (index < common.length && index < segments.length && common[index] === segments[index]) {
      index += 1;
    }
    common = common.slice(0, index);
  }
  if (common.length === 0) return undefined;
  return common.join(sep) || sep;
}

function basename(path: string): string {
  const index = path.lastIndexOf(sep);
  return index < 0 ? path : path.slice(index + 1);
}
