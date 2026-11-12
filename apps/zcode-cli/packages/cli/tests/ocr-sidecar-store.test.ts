import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { FileSystemPort, OcrSidecar } from "@zcode/contracts";
import {
  fingerprintSource,
  loadOcrSidecar,
  relativePathFrom,
  writeOcrSidecar,
} from "../src/ocr/sidecar-store.js";
import { MemoryFileSystem } from "./fixtures/memory-file-system.js";

/**
 * sidecar 的存取层（spec：`docs/design/v2/capability-cli-blocks.md` §6.2 / §6.5 / §6.6）。
 *
 * ⚠️ 这一层是**命令面与文件系统之间唯一的桥** —— 指纹、路径基准、原子写都在这里，
 * 业务面拿到的契约（sidecar v3）由它保证。
 *
 * ⚠️ **原子写的另一半在 adapter 层**（`@zcode/adapters` 的 fs 适配器负责「先写临时
 * 文件再 rename」）—— 这一层只负责**把 `atomic: true` 传下去**，真正的并发可见性
 * 在 `packages/adapters/tests/ocr-sidecar-atomic.test.ts` 里验。
 */

const SOURCE_PATH = "/tmp/work/report.pdf";
const SIDECAR_PATH = "/tmp/work/report.pdf.zcode-ocr.json";

function sidecar(overrides: Partial<OcrSidecar> = {}): OcrSidecar {
  return {
    version: 3,
    source: { path: "report.pdf", sha256: "abc", bytes: 10, mtimeMs: 1 },
    engine: {
      name: "mineru",
      variant: "mineru",
      version: "4.1.7",
      tier: "basic",
      route: "mineru",
      assets: {},
    },
    artifactsDir: "report.pdf.mineru",
    pages: [
      {
        pageIndex: 0,
        widthPt: 595,
        heightPt: 842,
        status: "ok",
        composition: "text",
        otherElements: 0,
        elements: [{ category: "text", type: "text", bbox: [0.1, 0.2, 0.3, 0.4], text: "正文" }],
      },
    ],
    ...overrides,
  };
}

test("指纹是内容指纹 —— 内容变了 sha256 就变（mtime 不参与判定）", async () => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.files.set(SOURCE_PATH, "PDF-CONTENT");

  const first = await fingerprintSource(fileSystem, SOURCE_PATH);
  assert.equal(first.ok, true);
  assert.ok(first.ok);
  const expected = createHash("sha256").update("PDF-CONTENT", "utf8").digest("hex");
  assert.equal(first.fingerprint.sha256, expected);
  assert.equal(first.fingerprint.bytes, "PDF-CONTENT".length);

  // ⚠️ **只改内容、不改 mtime** ⇒ 指纹必须变（否则缓存会命中过期内容）。
  fileSystem.files.set(SOURCE_PATH, "PDF-CONTENT-CHANGED");
  const second = await fingerprintSource(fileSystem, SOURCE_PATH);
  assert.ok(second.ok);
  assert.notEqual(second.fingerprint.sha256, expected);
});

test("文件不存在 ⇒ not_found（不是 io_error）", async () => {
  const result = await fingerprintSource(new MemoryFileSystem(), "/tmp/work/missing.pdf");
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.reason, "not_found");
});

test("读不到内容哈希 ⇒ io_error（缓存只是加速手段，不该让命令失败）", async () => {
  const fileSystem = new MemoryFileSystem();
  // 端口没给哈希（不是抛错）⇒ 归到 io_error。
  const broken = {
    ...fileSystem,
    async readBinaryFile() {
      return {
        path: SOURCE_PATH,
        content: Buffer.from("x", "utf8"),
        bytesRead: 1,
        sizeBytes: 1,
      };
    },
  } as unknown as FileSystemPort;

  const result = await fingerprintSource(broken, SOURCE_PATH);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.reason, "io_error");
});

test("相对路径统一用 `/` 分隔；同目录返回 `.`（不是空串）", () => {
  assert.equal(relativePathFrom("/tmp/work", "/tmp/work/report.pdf.mineru"), "report.pdf.mineru");
  assert.equal(relativePathFrom("/tmp/work", "/tmp/work/images/p0.jpg"), "images/p0.jpg");
  assert.equal(relativePathFrom("/tmp/work", "/tmp/work"), ".");
  assert.ok(!relativePathFrom("/tmp/work", "/tmp/work").includes("/"));
});

test("写 sidecar 是原子写并建目录；内容是缩进 JSON + 结尾换行", async () => {
  const fileSystem = new MemoryFileSystem();

  await writeOcrSidecar(fileSystem, SIDECAR_PATH, sidecar());

  const write = fileSystem.writes.find((entry) => entry.path === SIDECAR_PATH);
  assert.ok(write, "必须写 sidecar");
  assert.equal(write.atomic, true, "sidecar 必须原子写（并发读者不得看到半截 JSON）");
  assert.equal(write.createParents, true);
  assert.ok(write.content.endsWith("\n"));
  const parsed = JSON.parse(write.content) as { version: number };
  assert.equal(parsed.version, 3);
});

test("写完能读回来（往返一致）", async () => {
  const fileSystem = new MemoryFileSystem();

  await writeOcrSidecar(fileSystem, SIDECAR_PATH, sidecar());
  const loaded = await loadOcrSidecar(fileSystem, SIDECAR_PATH);

  assert.ok(loaded, "必须读得回来");
  assert.equal(loaded.version, 3);
  assert.equal(loaded.artifactsDir, "report.pdf.mineru");
  assert.equal(loaded.pages[0]?.elements[0]?.text, "正文");
});

test("坏缓存当没有缓存 —— 读不到 / 坏 JSON / 版本不对都返回 undefined", async () => {
  const fileSystem = new MemoryFileSystem();

  assert.equal(await loadOcrSidecar(fileSystem, SIDECAR_PATH), undefined, "文件不存在");

  fileSystem.files.set(SIDECAR_PATH, "{ 这不是 JSON");
  assert.equal(await loadOcrSidecar(fileSystem, SIDECAR_PATH), undefined, "坏 JSON");

  // ⚠️ **版本号不复用** —— v2 是已废止的历史变体，必须当没有缓存。
  fileSystem.files.set(SIDECAR_PATH, JSON.stringify({ ...sidecar(), version: 2 }));
  assert.equal(await loadOcrSidecar(fileSystem, SIDECAR_PATH), undefined, "版本不对");
});
