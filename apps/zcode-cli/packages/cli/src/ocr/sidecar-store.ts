import { relative, resolve, sep } from "node:path";
import type { FileSystemPort, OcrSidecar } from "@zcode/contracts";
import { OcrSidecarSchema } from "@zcode/contracts";

/**
 * 产物 sidecar 的存取（spec：capability-cli-blocks.md §6.5 / §6.6）。
 *
 * ⚠️ **所有文件 IO 走 `FileSystemPort`** —— 命令面不直接碰 `node:fs`。
 * ⚠️ **写是原子的**（先写临时文件再 rename，由端口保证）⇒ 并发读者永远看不到半截 JSON。
 */

/** sidecar 的读取上限。sidecar 带逐元素文字，会随正文增长，但不该无上限读。 */
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;

/** 参与内容指纹的文件大小上限（1GB）。超过就只解析、不做缓存。 */
const MAX_HASHABLE_BYTES = 1024 * 1024 * 1024;

/**
 * 源文件的**内容**指纹（spec §6.5 判据 2）。
 *
 * ⚠️ **必须是内容指纹，不是 mtime** —— mtime 会被复制 / 同步工具改。
 */
export interface SourceFingerprint {
  /** 十六进制 sha256（不带 `sha256:` 前缀）。 */
  readonly sha256: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** 指纹取不到时的原因。 */
export type FingerprintFailure = "not_found" | "too_large" | "io_error";

export type FingerprintResult =
  | { readonly ok: true; readonly fingerprint: SourceFingerprint }
  | { readonly ok: false; readonly reason: FingerprintFailure };

/**
 * 取源文件的内容指纹。
 *
 * ⚠️ **文件太大时不是错误**（`too_large`）：解析照常做，只是**没有缓存可命中**、
 * **不写 sidecar** —— 业务拿到的是一次成功的解析，不是失败。
 */
export async function fingerprintSource(
  fileSystem: FileSystemPort,
  path: string,
): Promise<FingerprintResult> {
  let content;
  try {
    content = await fileSystem.readBinaryFile({ path, maxBytes: MAX_HASHABLE_BYTES });
  } catch (error) {
    return { ok: false, reason: classifyFingerprintFailure(error) };
  }
  const hash = content.revision?.hash;
  if (typeof hash !== "string" || hash === "") {
    return { ok: false, reason: "io_error" };
  }
  return {
    ok: true,
    fingerprint: {
      sha256: hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash,
      bytes: content.sizeBytes,
      mtimeMs: content.revision?.mtimeMs ?? 0,
    },
  };
}

function classifyFingerprintFailure(error: unknown): FingerprintFailure {
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  if (code === "not_found") return "not_found";
  if (code === "too_large") return "too_large";
  return "io_error";
}

/**
 * 读已存在的 sidecar。
 *
 * ⚠️ **读不到 / 解析失败 / 版本不对 ⇒ 当作没有缓存**（返回 `undefined`）——
 * 缓存只是加速手段，坏掉的 sidecar 不该让命令失败；下一次会重算并覆盖它。
 */
export async function loadOcrSidecar(
  fileSystem: FileSystemPort,
  path: string,
): Promise<OcrSidecar | undefined> {
  let content: string;
  try {
    content = (await fileSystem.readTextFile({ path, maxBytes: MAX_SIDECAR_BYTES })).content;
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const result = OcrSidecarSchema.safeParse(parsed);
  return result.success ? (result.data as OcrSidecar) : undefined;
}

/** 原子写 sidecar（先写临时文件再 rename）。 */
export async function writeOcrSidecar(
  fileSystem: FileSystemPort,
  path: string,
  sidecar: OcrSidecar,
): Promise<void> {
  await fileSystem.writeTextFile({
    path,
    content: `${JSON.stringify(sidecar, null, 2)}\n`,
    atomic: true,
    createParents: true,
  });
}

/**
 * 相对路径（**统一用 `/` 分隔**）。
 *
 * ⚠️ **基准写死**（spec §6.2）：`artifactsDir` 相对 sidecar 所在目录；
 * 产物内的路径相对 `artifactsDir`。同目录时返回 `"."`（不是空串 —— 空串拼路径会少一段）。
 */
export function relativePathFrom(baseDirectory: string, target: string): string {
  const relativePath = relative(resolve(baseDirectory), resolve(target));
  if (relativePath === "") return ".";
  return relativePath.split(sep).join("/");
}
