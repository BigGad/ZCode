import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PdfDocumentPortError,
  createRootTraceContext,
  createSessionId,
  createTurnId,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionResult,
} from "@zcode/contracts";
import { createPopplerPdfDocumentAdapter } from "../src/pdf/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Poppler PDF adapter", () => {
  it("uses the fixed Poppler argv, timeouts and ordered JPEG output", async () => {
    const tempRoot = await temporaryRoot();
    const requests: ExecutionRequest[] = [];
    const executionPort = executionPortWith(async (request) => {
      requests.push(request);
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-3.jpg`, "page-three");
      await writeFile(`${outputPrefix}-2.jpg`, "page-two");
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    const pages = await adapter.renderPages(
      { filePath: "/tmp/report.pdf", firstPage: 2, lastPage: 3, trace: trace() },
      { signal: new AbortController().signal },
    );

    expect(pages.map((page) => [page.pageNumber, Buffer.from(page.data).toString()])).toEqual([
      [2, "page-two"],
      [3, "page-three"],
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      command: { mode: "argv", file: "pdftoppm", args: ["-v"] },
      timeoutMs: 5_000,
    });
    expect(requests[1]).toMatchObject({
      command: {
        mode: "argv",
        file: "pdftoppm",
        args: ["-jpeg", "-r", "100", "-f", "2", "-l", "3", "/tmp/report.pdf", expect.any(String)],
      },
      timeoutMs: 120_000,
    });
    expect(dirname((requests[1]!.command as { args: string[] }).args.at(-1)!)).toMatch(
      new RegExp(`^${escapeRegExp(tempRoot)}/zcode-read-pdf-`, "u"),
    );
    expect(basename((requests[1]!.command as { args: string[] }).args.at(-1)!)).toBe("page");
  });

  it("uses pdfinfo only for page-count inspection", async () => {
    const executionPort = executionPortWith(async () =>
      completedResult({ stdout: "Pages:          12\n" }),
    );
    const adapter = createPopplerPdfDocumentAdapter({ executionPort });

    await expect(
      adapter.getPageCount({ filePath: "/tmp/report.pdf", trace: trace() }),
    ).resolves.toBe(12);
    expect(executionPort.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { mode: "argv", file: "pdfinfo", args: ["/tmp/report.pdf"] },
        timeoutMs: 10_000,
      }),
      undefined,
    );
  });

  it("maps Poppler page-range failures to a precise user-facing error", async () => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      return failedResult(
        "Wrong page range given: the first page (99) can not be after the last page (2).",
      );
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 99,
        lastPage: 99,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "page_out_of_range",
      message:
        'Requested page 99 is outside the document (PDF has 2 pages). Use a range within 1-2, maximum 20 pages per request (e.g. pages: "1-2").',
    });
  });

  it("maps a zero-page Poppler range failure to the corrupted-PDF error", async () => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      return failedResult(
        "Wrong page range given: the first page (1) can not be after the last page (0).",
      );
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "corrupted",
      message: "PDF reports 0 pages (empty page tree). The PDF may be invalid.",
    });
  });

  it.each([
    {
      code: "io_error",
      filePath: "/tmp/report.pdf",
      stderr: "I/O Error: Couldn't open file '/tmp/report.pdf': No such file or directory.",
    },
    {
      code: "permission_denied",
      filePath: "/tmp/report.pdf",
      stderr: "Permission Error: Couldn't open file '/tmp/report.pdf': Permission denied.",
    },
    {
      code: "io_error",
      filePath: "/tmp/encrypted.pdf",
      stderr: "I/O Error: Couldn't open file '/tmp/encrypted.pdf': No such file or directory.",
    },
  ])("maps Poppler input diagnostics to $code", async ({ code, filePath, stderr }) => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      return args.includes("-v") ? completedResult() : failedResult(stderr);
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath,
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code,
      message: `Could not render PDF: ${stderr}`,
    });
  });

  it.each(["Permission denied", "Syntax Error: Illegal file spec"])(
    "leaves an unrecognized Poppler diagnostic as process_failed: %s",
    async (stderr) => {
      const tempRoot = await temporaryRoot();
      const executionPort = executionPortWith(async (request) => {
        const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
        if (args.includes("-v")) return completedResult();
        return failedResult(stderr);
      });
      const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

      await expect(
        adapter.renderPages({
          filePath: "/tmp/report.pdf",
          firstPage: 1,
          lastPage: 1,
          trace: trace(),
        }),
      ).rejects.toMatchObject({
        code: "process_failed",
        message: `pdftoppm failed: ${stderr}`,
      });
    },
  );

  it.each([
    "Syntax Error: Couldn't find trailer dictionary",
    "Syntax Error (42): Couldn't read xref table",
  ])("maps a known broken PDF structure to corrupted: %s", async (stderr) => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      return failedResult(stderr);
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "corrupted",
      message: "PDF file is corrupted or invalid.",
    });
  });

  it("maps successful rendering without page images to the corrupted-PDF error", async () => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async () => completedResult());
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "corrupted",
      message: "pdftoppm produced no output pages. The PDF may be invalid.",
    });
  });

  it("accepts and caches a non-127 availability result with stderr", async () => {
    const tempRoot = await temporaryRoot();
    let availabilityAttempts = 0;
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) {
        availabilityAttempts += 1;
        return failedResult("pdftoppm version 25.0", 1);
      }
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-1.jpg`, "page-one");
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).resolves.toHaveLength(1);
    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).resolves.toHaveLength(1);
    expect(availabilityAttempts).toBe(1);
  });

  it("caches only successful availability checks", async () => {
    const tempRoot = await temporaryRoot();
    let availabilityAttempts = 0;
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) {
        availabilityAttempts += 1;
        return availabilityAttempts === 1
          ? spawnFailure("spawn pdftoppm ENOENT")
          : completedResult();
      }
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-1.jpg`, "page-one");
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message:
        "pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.",
    });
    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).resolves.toHaveLength(1);
    expect(availabilityAttempts).toBe(2);
  });

  it("preserves an availability-check timeout as a timeout", async () => {
    const executionPort = executionPortWith(async () => ({
      ...completedResult(),
      status: "timed_out",
      timedOut: true,
    }));
    const adapter = createPopplerPdfDocumentAdapter({ executionPort });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "timeout",
      message: "PDF page extraction availability check timed out after 5000ms.",
    });
  });

  it("propagates cancellation while loading rendered pages and removes the temp directory", async () => {
    const tempRoot = await temporaryRoot();
    const controller = new AbortController();
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-1.jpg`, "page-one");
      controller.abort();
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages(
        { filePath: "/tmp/report.pdf", firstPage: 1, lastPage: 1, trace: trace() },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("maps temporary-directory creation failures to io_error", async () => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async () => completedResult());
    const adapter = createPopplerPdfDocumentAdapter({
      executionPort,
      tempRoot: join(tempRoot, "missing"),
    });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "io_error",
      message: "Unable to create a temporary directory for PDF page extraction.",
    });
  });

  it("maps rendered-page directory enumeration failures to io_error", async () => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      await rm(dirname(args.at(-1)!), { recursive: true, force: true });
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/report.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "io_error",
      message: "Unable to list rendered PDF page images.",
    });
  });
});

describe("Poppler PDF adapter password handling", () => {
  const PASSWORD = "s3cret-password";

  it("passes the password as -upw to both pdfinfo and pdftoppm", async () => {
    const tempRoot = await temporaryRoot();
    const requests: ExecutionRequest[] = [];
    const executionPort = executionPortWith(async (request) => {
      requests.push(request);
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-1.jpg`, "page-one");
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await adapter.getPageCount({ filePath: "/tmp/locked.pdf", password: PASSWORD, trace: trace() });
    await adapter.renderPages(
      { filePath: "/tmp/locked.pdf", firstPage: 1, lastPage: 1, password: PASSWORD, trace: trace() },
      { signal: new AbortController().signal },
    );

    const pdfinfo = requests.find((request) =>
      (request.command as { file?: string }).file === "pdfinfo");
    expect((pdfinfo!.command as { args: string[] }).args).toEqual([
      "-upw",
      PASSWORD,
      "/tmp/locked.pdf",
    ]);
    const render = requests.filter((request) => {
      const command = request.command as { file?: string; args?: string[] };
      return command.file === "pdftoppm" && !command.args?.includes("-v");
    });
    expect(render).toHaveLength(1);
    expect((render[0]!.command as { args: string[] }).args).toEqual([
      "-jpeg",
      "-r",
      "100",
      "-f",
      "1",
      "-l",
      "1",
      "-upw",
      PASSWORD,
      "/tmp/locked.pdf",
      expect.any(String),
    ]);
  });

  it("retries once with -opw when the user-password attempt is rejected", async () => {
    const tempRoot = await temporaryRoot();
    const attempts: string[][] = [];
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      attempts.push(args);
      if (args.includes("-upw")) {
        return failedResult("Command Line Error: Incorrect password");
      }
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-1.jpg`, "page-one");
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/locked.pdf",
        firstPage: 1,
        lastPage: 1,
        password: PASSWORD,
        trace: trace(),
      }),
    ).resolves.toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toContain("-upw");
    expect(attempts[1]).toContain("-opw");
    expect(attempts[1]).toContain(PASSWORD);
  });

  it("surfaces password_protected after both password variants fail", async () => {
    const tempRoot = await temporaryRoot();
    let renderAttempts = 0;
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      renderAttempts += 1;
      return failedResult("Command Line Error: Incorrect password");
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/locked.pdf",
        firstPage: 1,
        lastPage: 1,
        password: PASSWORD,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "password_protected",
      message: "PDF password was rejected; the password may be incorrect or insufficient.",
    });
    expect(renderAttempts).toBe(2);
  });

  it("keeps the no-password message when rendering fails without a supplied password", async () => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      return args.includes("-v")
        ? completedResult()
        : failedResult("Command Line Error: Incorrect password");
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.renderPages({
        filePath: "/tmp/locked.pdf",
        firstPage: 1,
        lastPage: 1,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "password_protected",
      message: "PDF is password-protected. Please provide an unprotected version.",
    });
  });

  it("throws password_protected from getPageCount only on a non-zero exit with password stderr", async () => {
    const executionPort = executionPortWith(async (request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-upw")) return failedResult("Command Line Error: Incorrect password");
      return completedResult({ stdout: "Pages:          4\n" });
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort });

    await expect(
      adapter.getPageCount({ filePath: "/tmp/locked.pdf", password: "wrong", trace: trace() }),
    ).rejects.toMatchObject({
      code: "password_protected",
      message: "PDF password was rejected; the password may be incorrect.",
    });
    // owner-password-only PDF（exit=0）不受影响，仍正常返回页数。
    await expect(
      adapter.getPageCount({ filePath: "/tmp/locked.pdf", trace: trace() }),
    ).resolves.toBe(4);
  });

  it("keeps returning undefined for non-password pdfinfo failures", async () => {
    const executionPort = executionPortWith(async () =>
      failedResult("I/O Error: Couldn't open file '/tmp/missing.pdf'."),
    );
    const adapter = createPopplerPdfDocumentAdapter({ executionPort });

    await expect(
      adapter.getPageCount({ filePath: "/tmp/missing.pdf", trace: trace() }),
    ).resolves.toBeUndefined();
  });

  /**
   * 解密（`pdftocairo -pdf`）—— spec：docs/design/v2/ocr-local.md §3.2.1。
   *
   * ⚠️ 存在的理由：本地解析引擎（MinerU 4.1.7）**没有密码入口**，加密 PDF 直接
   * 喂给它必报 `PDFium: Incorrect password error` ⇒ 密码由 ZCode 侧用 poppler 解密。
   */
  it("decrypts with pdftocairo, passing the password only through argv", async () => {
    const tempRoot = await temporaryRoot();
    const outputPath = join(tempRoot, "locked.pdf");
    const requests: ExecutionRequest[] = [];
    const executionPort = executionPortWith(async (request) => {
      requests.push(request);
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      await writeFile(outputPath, "%PDF-1.7 decrypted");
      return completedResult();
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    const decrypted = await adapter.decryptToFile({
      filePath: "/tmp/locked.pdf",
      password: "pw",
      outputPath,
      trace: trace(),
    });

    expect(decrypted.path).toBe(outputPath);
    expect(decrypted.bytes).toBeGreaterThan(0);
    // ⚠️ argv 形状固定：`-pdf -upw <密码> <输入> <输出>` —— 密码**只经 argv**。
    expect(requests[1]).toMatchObject({
      command: {
        mode: "argv",
        file: "pdftocairo",
        args: ["-pdf", "-upw", "pw", "/tmp/locked.pdf", outputPath],
      },
      timeoutMs: 120_000,
    });
  });

  it("retries with the owner-password variant once, then reports password_protected", async () => {
    const tempRoot = await temporaryRoot();
    const outputPath = join(tempRoot, "locked.pdf");
    const requests: ExecutionRequest[] = [];
    const executionPort = executionPortWith(async (request) => {
      requests.push(request);
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      if (args.includes("-v")) return completedResult();
      return failedResult("Command Line Error: Incorrect password\nError opening PDF file.");
    });
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.decryptToFile({
        filePath: "/tmp/locked.pdf",
        password: "wrong",
        outputPath,
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: "password_protected",
      message: "PDF password was rejected; the password may be incorrect.",
    });
    // ① 先试 user password；② 密码类失败才换 owner password 试一次。
    const decryptCalls = requests.filter((request) => {
      const args = request.command.mode === "argv" ? (request.command.args ?? []) : [];
      return args.includes("-pdf");
    });
    expect(decryptCalls).toHaveLength(2);
    expect(decryptCalls[0]).toMatchObject({
      command: { args: ["-pdf", "-upw", "wrong", "/tmp/locked.pdf", outputPath] },
    });
    expect(decryptCalls[1]).toMatchObject({
      command: { args: ["-pdf", "-opw", "wrong", "/tmp/locked.pdf", outputPath] },
    });
  });

  it("reports unavailable when pdftocairo is not installed", async () => {
    const tempRoot = await temporaryRoot();
    const executionPort = executionPortWith(async () => spawnFailure("spawn pdftocairo ENOENT"));
    const adapter = createPopplerPdfDocumentAdapter({ executionPort, tempRoot });

    await expect(
      adapter.decryptToFile({
        filePath: "/tmp/locked.pdf",
        password: "pw",
        outputPath: join(tempRoot, "locked.pdf"),
        trace: trace(),
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

function executionPortWith(run: (request: ExecutionRequest) => Promise<ExecutionResult>) {
  return { run: vi.fn(run) } as unknown as ExecutionPort & { run: ReturnType<typeof vi.fn> };
}

function completedResult(input: { stdout?: string } = {}): ExecutionResult {
  const now = new Date();
  return {
    status: "completed",
    exitCode: 0,
    stdout: stream(input.stdout ?? ""),
    stderr: stream(""),
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
  };
}

function failedResult(stderr: string, exitCode = 1): ExecutionResult {
  return { ...completedResult(), status: "failed", exitCode, stderr: stream(stderr) };
}

function spawnFailure(message: string): ExecutionResult {
  return {
    ...completedResult(),
    status: "spawn_error",
    error: { type: "spawn_error", message },
  };
}

function stream(text: string) {
  return { text, bytes: Buffer.byteLength(text), truncated: false };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-pdf-adapter-test-"));
  roots.push(root);
  return root;
}

function trace() {
  const sessionId = createSessionId("pdf-adapter");
  return createRootTraceContext({ sessionId, turnId: createTurnId("pdf-adapter") });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
