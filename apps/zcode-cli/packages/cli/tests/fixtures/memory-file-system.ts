import { createHash } from "node:crypto";
import {
  createFileSystemError,
  type FileSystemPort,
  type FileSystemReadBytesResult,
  type FileSystemReadTextResult,
  type FileSystemStatResult,
  type FileSystemWriteTextResult,
} from "@zcode/contracts";

/**
 * 内存文件系统（命令面测试用）。
 *
 * ⚠️ **只实现 sidecar 链路用到的那几个方法**（读二进制取指纹、读文本、原子写），
 * 其余方法直接抛「未实现」—— 宁可炸，也不要悄悄返回假数据。
 */
export class MemoryFileSystem implements FileSystemPort {
  /** 路径 → 文本内容。 */
  readonly files = new Map<string, string>();
  /** 路径 → 内容指纹（十六进制 sha256）。不给则按内容现算。 */
  readonly hashes = new Map<string, string>();
  /** 写记录（用来断言原子写与建目录）。 */
  readonly writes: Array<{
    path: string;
    content: string;
    atomic?: boolean;
    createParents?: boolean;
  }> = [];
  /** 固定 mtime（不给就用 1，便于断言）。 */
  readonly mtimeMs = 1;

  async createDirectory(request: { path: string }) {
    return { path: request.path };
  }

  async stat(request: { path: string }): Promise<FileSystemStatResult> {
    const content = this.files.get(request.path);
    if (content === undefined) {
      throw createFileSystemError({
        code: "not_found",
        path: request.path,
        message: `文件不存在：${request.path}`,
      });
    }
    return {
      path: request.path,
      kind: "file",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      mtimeMs: this.mtimeMs,
      revision: {
        id: request.path,
        hash: this.hashOf(request.path),
        sizeBytes: Buffer.byteLength(content, "utf8"),
      },
    };
  }

  async readTextFile(request: {
    path: string;
    encoding?: BufferEncoding;
    maxBytes?: number;
  }): Promise<FileSystemReadTextResult> {
    const content = this.files.get(request.path);
    if (content === undefined) {
      throw createFileSystemError({
        code: "not_found",
        path: request.path,
        message: `文件不存在：${request.path}`,
      });
    }
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const maxBytes = request.maxBytes ?? sizeBytes;
    const truncated = sizeBytes > maxBytes;
    const returned = truncated ? content.slice(0, maxBytes) : content;
    return {
      path: request.path,
      content: returned,
      encoding: "utf8",
      lineEndings: "LF",
      bytesRead: Buffer.byteLength(returned, "utf8"),
      sizeBytes,
      truncated,
      revision: { id: request.path, hash: this.hashOf(request.path), mtimeMs: this.mtimeMs },
    };
  }

  async readBinaryFile(request: {
    path: string;
    maxBytes?: number;
  }): Promise<FileSystemReadBytesResult> {
    const content = this.files.get(request.path);
    if (content === undefined) {
      throw createFileSystemError({
        code: "not_found",
        path: request.path,
        message: `文件不存在：${request.path}`,
      });
    }
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const maxBytes = request.maxBytes ?? sizeBytes;
    if (sizeBytes > maxBytes) {
      throw createFileSystemError({
        code: "too_large",
        path: request.path,
        message: `文件超过上限：${request.path}`,
      });
    }
    return {
      path: request.path,
      content: Buffer.from(content, "utf8"),
      bytesRead: sizeBytes,
      sizeBytes,
      revision: { id: request.path, hash: this.hashOf(request.path), mtimeMs: this.mtimeMs },
    };
  }

  async readTextFileRange(): Promise<never> {
    throw new Error("未实现：readTextFileRange");
  }

  async writeTextFile(request: {
    path: string;
    content: string;
    atomic?: boolean;
    createParents?: boolean;
  }): Promise<FileSystemWriteTextResult> {
    this.writes.push({
      path: request.path,
      content: request.content,
      ...(request.atomic !== undefined ? { atomic: request.atomic } : {}),
      ...(request.createParents !== undefined ? { createParents: request.createParents } : {}),
    });
    this.files.set(request.path, request.content);
    return {
      path: request.path,
      bytesWritten: Buffer.byteLength(request.content, "utf8"),
      revision: { id: request.path, hash: this.hashOf(request.path) },
    };
  }

  async removeFile(request: { path: string }) {
    this.files.delete(request.path);
    return { path: request.path, removed: true };
  }

  async listDirectory(): Promise<never> {
    throw new Error("未实现：listDirectory");
  }

  async searchFiles(): Promise<never> {
    throw new Error("未实现：searchFiles");
  }

  async searchText(): Promise<never> {
    throw new Error("未实现：searchText");
  }

  /** 内容指纹（十六进制 sha256）。 */
  hashOf(path: string): string {
    const pinned = this.hashes.get(path);
    if (pinned !== undefined) return pinned;
    const content = this.files.get(path) ?? "";
    return createHash("sha256").update(content, "utf8").digest("hex");
  }
}
