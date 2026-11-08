import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import * as yauzl from "yauzl";

// ============================================================
// 通用 zip 解包器（加固版）
// ============================================================

/**
 * 解包限额。默认值与 plugin zip 来源一致——plugin 商店与本地解析产物都是
 * 第三方二进制产出的 zip，威胁面相同，限额不该有两套。
 */
export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
export const ZIP_EXTRACT_MAX_BYTES = 500 * 1024 * 1024;

export type ZipEntryKind = "directory" | "file";

export interface ZipExtractOptions {
  /** zip 文件绝对路径。 */
  readonly archivePath: string;
  /** 解包目标根目录；不存在会被创建。 */
  readonly targetRoot: string;
  readonly signal?: AbortSignal;
  /** 报错文案里的归档名，默认 "Zip archive"。plugin 来源传 "Plugin zip"。 */
  readonly label?: string;
  readonly maxEntries?: number;
  readonly maxSingleFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface ZipExtractResult {
  /** 条目名的第一段集合（用于判断 zip 是不是单根目录结构）。 */
  readonly topLevelSegments: Set<string>;
}

/**
 * 把 zip 解到 targetRoot。
 *
 * ⚠️ **路径穿越是硬要求**：解的是**第三方二进制的产物**，条目名随版本变 ⇒ 必须做
 * 路径规范化（拒绝 `..`、绝对路径、`\`、NUL），并用限额挡住 zip bomb。
 */
export async function extractZipArchive(options: ZipExtractOptions): Promise<ZipExtractResult> {
  const label = options.label ?? "Zip archive";
  const maxEntries = options.maxEntries ?? ZIP_MAX_ENTRIES;
  const maxSingleFileBytes = options.maxSingleFileBytes ?? ZIP_MAX_SINGLE_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? ZIP_EXTRACT_MAX_BYTES;
  const targetRoot = resolve(options.targetRoot);
  await mkdir(targetRoot, { recursive: true });
  const zipFile = await openZipFile(options.archivePath, label);
  const topLevelSegments = new Set<string>();
  let entryCount = 0;
  let extractedBytes = 0;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const rejectOnce = (error: unknown): void => {
        zipFile.close();
        rejectPromise(error);
      };
      zipFile.once("error", rejectOnce);
      zipFile.once("end", () => {
        zipFile.removeListener("error", rejectOnce);
        resolvePromise();
      });
      zipFile.on("entry", (entry) => {
        void (async () => {
          try {
            throwIfAborted(options.signal);
            entryCount += 1;
            if (entryCount > maxEntries) {
              throw new Error(`${label} has too many entries: ${entryCount}/${maxEntries}`);
            }

            const normalizedPath = normalizeZipRelativePath(entry.fileName);
            topLevelSegments.add(normalizedPath.split("/")[0] ?? normalizedPath);
            const targetPath = resolveZipPathWithin(targetRoot, normalizedPath);
            const kind = classifyZipEntry(entry, label);
            if (kind === "directory") {
              await mkdir(targetPath, { recursive: true });
              zipFile.readEntry();
              return;
            }

            if (entry.uncompressedSize > maxSingleFileBytes) {
              throw new Error(`${label} entry exceeds single file limit: ${entry.fileName}`);
            }
            const bytes = await readZipEntryBuffer(
              zipFile,
              entry,
              maxSingleFileBytes,
              options.signal,
              label,
            );
            extractedBytes += bytes.byteLength;
            if (extractedBytes > maxTotalBytes) {
              throw new Error(
                `${label} extracted content exceeds limit: ${extractedBytes}/${maxTotalBytes}`,
              );
            }
            await mkdir(dirname(targetPath), { recursive: true });
            await writeFile(targetPath, bytes);
            zipFile.readEntry();
          } catch (error) {
            rejectOnce(error);
          }
        })();
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }

  return { topLevelSegments };
}

/**
 * 规范化 zip 条目名。拒绝 `..`、绝对路径、`\`、NUL 与空段。
 */
export function normalizeZipRelativePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error(`Unsafe zip path: ${path}`);
  }
  const withoutTrailingSlash = path.replace(/\/+$/u, "");
  if (
    !withoutTrailingSlash ||
    path.includes("\\") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    /^[a-zA-Z]:/u.test(path)
  ) {
    throw new Error(`Unsafe zip path: ${path}`);
  }
  const parts = withoutTrailingSlash.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe zip path: ${path}`);
  }
  return withoutTrailingSlash;
}

/**
 * 把相对条目名解析成目标根目录内的绝对路径；越界即抛。
 */
export function resolveZipPathWithin(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath);
  const target = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe zip path: ${relativePath}`);
  }
  return target;
}

/**
 * 判定条目是目录还是文件。加密条目与符号链接一律拒绝。
 */
export function classifyZipEntry(entry: yauzl.Entry, label = "Zip archive"): ZipEntryKind {
  const isDirectoryByName = entry.fileName.endsWith("/");
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error(`${label} encrypted entries are not supported: ${entry.fileName}`);
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) {
    throw new Error(`${label} entry symlinks are not supported: ${entry.fileName}`);
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new Error(`Unsupported ${label} entry type: ${entry.fileName}`);
  }
  if (fileType === 0o040000 || isDirectoryByName) return "directory";
  return "file";
}

function openZipFile(path: string, label: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!zipFile) {
        rejectPromise(new Error(`Failed to open ${label}: ${path}`));
        return;
      }
      resolvePromise(zipFile);
    });
  });
}

function readZipEntryBuffer(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxSingleFileBytes: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!stream) {
        rejectPromise(new Error(`Failed to read ${label} entry: ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      let bytesRead = 0;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        stream.destroy(new Error(`${label} operation cancelled`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.byteLength;
        if (bytesRead > maxSingleFileBytes) {
          stream.destroy(new Error(`${label} entry exceeds single file limit: ${entry.fileName}`));
          return;
        }
        chunks.push(buffer);
      });
      stream.once("error", (streamError) => {
        cleanup();
        rejectPromise(streamError);
      });
      stream.once("end", () => {
        cleanup();
        resolvePromise(Buffer.concat(chunks));
      });
    });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Zip operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}
