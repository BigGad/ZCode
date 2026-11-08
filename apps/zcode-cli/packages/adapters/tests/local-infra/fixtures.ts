import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecutionPort, ExecutionRequest, ExecutionResult } from "@zcode/contracts";

// ============================================================
// 本地基础设施测试夹具
// ============================================================

/**
 * 最小 zip 写入器（store 模式，不压缩）。
 *
 * ⚠️ **不引 `yazl`**：adapters 包的依赖面不该为了测试夹具多一个第三方包。
 * store 模式的 zip 足够 `yauzl` 读取（`validateEntrySizes` 会校验 CRC 与长度）。
 */
export interface ZipEntryInput {
  readonly name: string;
  readonly content: string | Buffer;
  /** unix 权限位（默认 0o644）；用于构造符号链接条目。 */
  readonly mode?: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 构造一个 store 模式的 zip。条目名按原样写入（可用来构造恶意条目名）。 */
export function buildZip(entries: readonly ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, "utf8");
    const checksum = crc32(content);
    const mode = entry.mode ?? 0o644;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // method = store
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date（固定值，保证产物可复现）
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, nameBytes, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4); // made by：unix
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(mode << 16, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);

    offset += localHeader.byteLength + nameBytes.byteLength + content.byteLength;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** MinerU 4.x 的产物三件套（文件名按实测）。 */
export function mineruArtifacts(tier: string): ZipEntryInput[] {
  return [
    { name: "markdown.md", content: `# 标题\n\n正文\n` },
    {
      name: "structured_content.json",
      content: JSON.stringify({
        pages: [{ page_idx: 0, blocks: [{ type: "text", text: "正文" }] }],
        metadata: {},
        extensions: { mineru: { tier, parse_mode: "auto" } },
        is_full_document: true,
      }),
    },
    {
      name: "middle_json.json",
      content: JSON.stringify({
        schema: "docvortex.middle",
        schema_version: "1",
        pages: [{ page_idx: 0, blocks: [{ index: 0, type: "text", text: "正文" }] }],
        metadata: {},
        extensions: { mineru: { tier, parse_mode: "auto" } },
        is_full_document: true,
      }),
    },
  ];
}

/** 造一个可执行的假 `mineru-kit`（定位器要 stat + X_OK 判定它存在）。 */
export async function createFakeEngine(root: string): Promise<string> {
  const directory = join(root, "fake-bin");
  await mkdir(directory, { recursive: true });
  const kitPath = join(directory, "mineru-kit");
  await writeFile(kitPath, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await chmod(kitPath, 0o755);
  // 版本检查用的 sibling（`mineru`）——刻意与 `mineru-kit` 同目录。
  const versionToolPath = join(directory, "mineru");
  await writeFile(versionToolPath, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await chmod(versionToolPath, 0o755);
  return kitPath;
}

/** 假引擎的硬件探测输出。 */
export function hardwareDetectJson(input: {
  readonly ceiling?: string;
  readonly pdfImageTiers?: readonly string[];
  readonly defaultRequestTier?: string;
  readonly device?: string;
}): string {
  return JSON.stringify({
    ...(input.ceiling !== undefined ? { ceiling: input.ceiling } : {}),
    pdf_image_tiers: input.pdfImageTiers ?? ["flash", "basic", "standard", "advanced"],
    ...(input.defaultRequestTier !== undefined
      ? { default_request_tier: input.defaultRequestTier }
      : {}),
    ...(input.device !== undefined ? { device: input.device } : {}),
  });
}

/** `mineru-kit models show` 的人读文本。 */
export function modelsShowText(): string {
  return [
    "模型仓库：",
    "  MinerU-4_models_torch",
    "    路径: /Users/tester/.mineru/models/MinerU-4_models_torch",
    "    状态: 已就绪",
    "模型档位：",
    "  basic: MinerU-4_models_torch",
    "  standard: MinerU-4_models_torch",
  ].join("\n");
}

export interface FakeExecutionOptions {
  readonly handler: (request: ExecutionRequest) => Promise<ExecutionResult> | ExecutionResult;
}

/** 造一个假的 ExecutionPort，同时保留调用记录。 */
export function fakeExecutionPort(
  handler: (request: ExecutionRequest) => Promise<ExecutionResult> | ExecutionResult,
): ExecutionPort & { calls: ExecutionRequest[] } {
  const calls: ExecutionRequest[] = [];
  return {
    calls,
    async run(request: ExecutionRequest): Promise<ExecutionResult> {
      calls.push(request);
      return handler(request);
    },
  } as ExecutionPort & { calls: ExecutionRequest[] };
}

export function completedResult(input: { stdout?: string; stderr?: string } = {}): ExecutionResult {
  const now = new Date();
  return {
    status: "completed",
    exitCode: 0,
    stdout: stream(input.stdout ?? ""),
    stderr: stream(input.stderr ?? ""),
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
  };
}

export function failedResult(stderr: string, exitCode = 1): ExecutionResult {
  return { ...completedResult(), status: "failed", exitCode, stderr: stream(stderr) };
}

export function timedOutResult(): ExecutionResult {
  return { ...completedResult(), status: "timed_out", timedOut: true };
}

function stream(text: string) {
  return { text, bytes: Buffer.byteLength(text), truncated: false };
}

/** 从执行请求里取 argv。 */
export function argvOf(request: ExecutionRequest): string[] {
  return request.command.mode === "argv" ? (request.command.args ?? []) : [];
}

/** 写文件并保证父目录存在。 */
export async function writeFileEnsured(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
