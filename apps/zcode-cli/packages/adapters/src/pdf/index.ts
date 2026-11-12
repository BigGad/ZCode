import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PdfDocumentPortError,
  READ_PDF_AVAILABILITY_TIMEOUT_MS,
  READ_PDF_DECRYPT_TIMEOUT_MS,
  READ_PDF_INFO_TIMEOUT_MS,
  READ_PDF_LAYOUT_TIMEOUT_MS,
  READ_PDF_MAX_PAGES_PER_REQUEST,
  READ_PDF_RENDER_TIMEOUT_MS,
  type ExecutionPort,
  type ExecutionResult,
  type PdfDocumentAnalyzeLayoutRequest,
  type PdfDocumentDecryptRequest,
  type PdfDocumentDecryptedFile,
  type PdfDocumentPageCountRequest,
  type PdfDocumentPort,
  type PdfDocumentRenderPagesRequest,
  type PdfDocumentRenderedPage,
  type PdfLayoutAnalysis,
} from "@zcode/contracts";
import { PDFTOHTML_OUTPUT_BASENAME, parsePdftohtmlXml } from "./layout-xml.js";

export interface PopplerPdfDocumentAdapterOptions {
  executionPort: ExecutionPort;
  tempRoot?: string;
}

const BROKEN_PDF_STRUCTURE_PATTERN =
  /Syntax Error(?: \(\d+\))?: Couldn't (?:find trailer dictionary|read xref table)/iu;

/**
 * Poppler 判定「密码不对」的 stderr 片段。
 * ⚠️ 实测 `pdftocairo -pdf -upw <错密码>` 的 stderr 是：
 * `Command Line Error: Incorrect password` + `Error opening PDF file.`（退出码 1）。
 */
const INCORRECT_PASSWORD_PATTERN = /incorrect password/iu;

/** poppler 的 PDF→PDF 重编码（`pdftocairo -pdf`）。 */
const PDFCAIRO_BINARY = "pdftocairo";
/** poppler 的渲染（`pdftoppm`）。 */
const PDFTOPPM_BINARY = "pdftoppm";
/** poppler 的原生版面分析（`pdftohtml -xml`）。 */
const PDFTOHTML_BINARY = "pdftohtml";

export function createPopplerPdfDocumentAdapter(
  options: PopplerPdfDocumentAdapterOptions,
): PdfDocumentPort {
  return new PopplerPdfDocumentAdapter(options);
}

class PopplerPdfDocumentAdapter implements PdfDocumentPort {
  /** 已确认装好的 poppler 二进制（按二进制名记，避免为一个探另一个也白跑一次）。 */
  private readonly availableBinaries = new Set<string>();

  constructor(private readonly options: PopplerPdfDocumentAdapterOptions) {}

  async getPageCount(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined> {
    const result = await this.options.executionPort.run(
      {
        command: {
          mode: "argv",
          file: "pdfinfo",
          // 密码仅经 argv 传给子进程（poppler 无 stdin/env 通道）；ps 可见性在 spec 安全节已声明。
          args: request.password
            ? ["-upw", request.password, request.filePath]
            : [request.filePath],
        },
        timeoutMs: READ_PDF_INFO_TIMEOUT_MS,
        trace: request.trace,
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (result.cancelled || options?.signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF inspection was cancelled.");
    }
    if (result.status !== "completed" || result.exitCode !== 0) {
      // 根因：加密 PDF 的 pdfinfo exit≠0 且 stderr 含 password；原先返回 undefined 会让
      // 调用方把加密文件当普通文件处理（如 Read 原生路径直传加密字节给 provider）。
      // 仅在 exit≠0 时抛出，exit=0 的 owner-password-only 可渲染 PDF 不受影响。
      if (/password/iu.test(result.stderr.text)) {
        throw new PdfDocumentPortError(
          "password_protected",
          request.password
            ? "PDF password was rejected; the password may be incorrect."
            : "PDF is password-protected. A password is required to open it.",
        );
      }
      return undefined;
    }
    const match = /^Pages:\s+(\d+)\s*$/imu.exec(result.stdout.text);
    const pageCount = Number(match?.[1]);
    return Number.isSafeInteger(pageCount) && pageCount >= 0 ? pageCount : undefined;
  }

  async renderPages(
    request: PdfDocumentRenderPagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentRenderedPage[]> {
    await this.ensureBinaryAvailable(request, PDFTOPPM_BINARY, options?.signal);
    let directory: string;
    try {
      directory = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "zcode-read-pdf-"));
    } catch (error) {
      throwPdfIoError(
        error,
        options?.signal,
        "Unable to create a temporary directory for PDF page extraction.",
      );
    }
    const outputPrefix = join(directory, "page");
    let operationFailed = false;
    const runRender = (passwordFlag: "-upw" | "-opw") =>
      this.options.executionPort.run(
        {
          command: {
            mode: "argv",
            file: "pdftoppm",
            args: [
              "-jpeg",
              "-r",
              "100",
              "-f",
              String(request.firstPage),
              "-l",
              String(request.lastPage),
              // 单密码字段双变体：先按 user password (-upw) 尝试，密码错误再按 owner password (-opw) 重试。
              ...(request.password ? [passwordFlag, request.password] : []),
              request.filePath,
              outputPrefix,
            ],
          },
          timeoutMs: READ_PDF_RENDER_TIMEOUT_MS,
          trace: request.trace,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
    try {
      let result = await runRender("-upw");
      try {
        assertRenderSucceeded(result, request);
      } catch (error) {
        // 仅密码类失败值得换 owner-password 变体重试一次；其他失败重试只会重复成本。
        if (
          !request.password ||
          !(error instanceof PdfDocumentPortError) ||
          error.code !== "password_protected"
        ) {
          throw error;
        }
        result = await runRender("-opw");
        assertRenderSucceeded(result, request);
      }
      return await readRenderedPages(directory, options?.signal);
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        // 根因：清理错误覆盖主错误会丢失已经完成的 Poppler 稳定分类；仅当主流程
        // 成功时把清理失败暴露为 I/O 错误，失败路径继续保留原始原因。
        if (!operationFailed) {
          throwPdfIoError(error, options?.signal, "Unable to remove temporary PDF page images.");
        }
      }
    }
  }

  private async ensureBinaryAvailable(
    request: PdfDocumentPageCountRequest,
    binary: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.availableBinaries.has(binary)) return;
    const result = await this.options.executionPort.run(
      {
        command: { mode: "argv", file: binary, args: ["-v"] },
        timeoutMs: READ_PDF_AVAILABILITY_TIMEOUT_MS,
        trace: request.trace,
      },
      signal ? { signal } : undefined,
    );
    if (result.cancelled || signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.");
    }
    if (result.timedOut || result.status === "timed_out") {
      // 根因：可用性探测超时表示命令已启动但未及时响应，不等于缺少 Poppler。
      throw new PdfDocumentPortError(
        "timeout",
        `PDF page extraction availability check timed out after ${READ_PDF_AVAILABILITY_TIMEOUT_MS}ms.`,
      );
    }
    if (!isAvailableProbeResult(result)) {
      throw new PdfDocumentPortError(
        "unavailable",
        `${binary} is not installed. Install poppler-utils (e.g. \`brew install poppler\` or \`apt-get install poppler-utils\`) to enable PDF page rendering.`,
        { cause: result.error?.cause },
      );
    }
    // 失败结果不能缓存；用户安装 Poppler 后同一进程应能立即恢复。
    this.availableBinaries.add(binary);
  }

  /**
   * 把加密 PDF 解成一份**无密副本**（`pdftocairo -pdf`）。
   *
   * ⚠️ **为什么要 ZCode 自己解密**：本地解析引擎（MinerU 4.1.7）没有密码入口 ——
   * 加密 PDF 直接喂给它必报 `PDFium: Incorrect password error`。路线见
   * docs/design/v2/ocr-local.md §3.2.1。
   * ⚠️ **密码只经 argv**（poppler 没有 stdin / env 通道）。
   * ⚠️ **`outputPath` 必须以 `.pdf` 结尾** —— `pdftocairo -pdf` 在输出名没有
   * 扩展名时会自己补 `.pdf`，那副本就落到别的路径上去了。
   */
  async decryptToFile(
    request: PdfDocumentDecryptRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentDecryptedFile> {
    await this.ensureBinaryAvailable(request, PDFCAIRO_BINARY, options?.signal);
    const runDecrypt = (passwordFlag: "-upw" | "-opw") =>
      this.options.executionPort.run(
        {
          command: {
            mode: "argv",
            file: PDFCAIRO_BINARY,
            args: [
              "-pdf",
              // 单密码字段双变体：先按 user password (-upw) 试，密码不对再按 owner password (-opw) 试。
              passwordFlag,
              request.password,
              request.filePath,
              request.outputPath,
            ],
          },
          timeoutMs: READ_PDF_DECRYPT_TIMEOUT_MS,
          trace: request.trace,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );

    let result = await runDecrypt("-upw");
    try {
      assertDecryptSucceeded(result);
    } catch (error) {
      // 仅密码类失败值得换 owner-password 变体重试一次；其他失败重试只会重复成本。
      if (!(error instanceof PdfDocumentPortError) || error.code !== "password_protected") {
        throw error;
      }
      result = await runDecrypt("-opw");
      assertDecryptSucceeded(result);
    }

    const bytes = await decryptedFileSize(request.outputPath, options?.signal);
    return { path: request.outputPath, bytes };
  }

  /**
   * **原生版面分析**：从 PDF 的文本层与内嵌图对象拿页尺寸 + 元素位置 + 文本内容。
   *
   * ⚠️ 走 poppler 的 `pdftohtml -xml`（实测见 spec §6.7）：一次调用同时给出
   * 页尺寸（pt）、文本碎片 bbox + 文本、内嵌图片 bbox，并把内嵌图片抽成 PNG
   * 落在 `outputDir` 里。
   * ⚠️ **加密 PDF 直接支持**（poppler 的 `-upw` / `-opw`）⇒ 不需要解密副本。
   */
  async analyzeLayout(
    request: PdfDocumentAnalyzeLayoutRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfLayoutAnalysis> {
    await this.ensureBinaryAvailable(request, PDFTOHTML_BINARY, options?.signal);
    try {
      await mkdir(request.outputDir, { recursive: true });
    } catch (error) {
      throwPdfIoError(
        error,
        options?.signal,
        "Unable to create the PDF analysis output directory.",
      );
    }
    const xmlPath = join(request.outputDir, `${PDFTOHTML_OUTPUT_BASENAME}.xml`);
    const runAnalysis = (passwordFlag: "-upw" | "-opw") =>
      this.options.executionPort.run(
        {
          command: {
            mode: "argv",
            file: PDFTOHTML_BINARY,
            args: [
              "-xml",
              // ⚠️ `-zoom 1` ⇒ 坐标单位是 pt（1/72 英寸）；`-noroundcoord` 保留小数。
              "-zoom",
              "1",
              "-noroundcoord",
              // ⚠️ `-hidden` 带上隐藏层的文本；`-nodrm` 不画水印；`-q` 安静模式。
              "-hidden",
              "-nodrm",
              "-q",
              // ⚠️ **密码只经 argv**（poppler 没有 stdin / env 通道）。
              ...(request.password !== undefined ? [passwordFlag, request.password] : []),
              request.filePath,
              xmlPath,
            ],
          },
          timeoutMs: READ_PDF_LAYOUT_TIMEOUT_MS,
          trace: request.trace,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );

    let result = await runAnalysis("-upw");
    try {
      assertLayoutSucceeded(result, request);
    } catch (error) {
      // 仅密码类失败值得换 owner-password 变体重试一次；其他失败重试只会重复成本。
      if (
        !request.password ||
        !(error instanceof PdfDocumentPortError) ||
        error.code !== "password_protected"
      ) {
        throw error;
      }
      result = await runAnalysis("-opw");
      assertLayoutSucceeded(result, request);
    }

    let xml: string;
    try {
      xml = await readFile(xmlPath, "utf8");
    } catch (error) {
      throwPdfIoError(error, options?.signal, "Unable to read the PDF layout analysis output.");
    }
    return parsePdftohtmlXml(xml, { xmlDirectory: dirname(xmlPath) });
  }
}

/** 副本落盘后的存在性与体积校验（拿不到就不是一次成功的解密）。 */
async function decryptedFileSize(path: string, signal: AbortSignal | undefined): Promise<number> {
  try {
    // ⚠️ `fs.promises.stat` **不支持 AbortSignal**（只有 readFile 那些支持）⇒ 不传。
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) {
      throw new PdfDocumentPortError("io_error", "PDF decryption produced an empty output file.");
    }
    return info.size;
  } catch (error) {
    if (error instanceof PdfDocumentPortError) throw error;
    throwPdfIoError(error, signal, "Unable to read the decrypted PDF copy.");
  }
}

/** `pdftocairo` 的失败归类：密码 / 损坏 / 其它。 */
function assertDecryptSucceeded(result: ExecutionResult): void {
  if (result.cancelled) {
    throw new PdfDocumentPortError("cancelled", "PDF decryption was cancelled.");
  }
  if (result.timedOut || result.status === "timed_out") {
    throw new PdfDocumentPortError(
      "timeout",
      `PDF decryption timed out after ${READ_PDF_DECRYPT_TIMEOUT_MS}ms.`,
    );
  }
  if (result.status === "completed" && result.exitCode === 0) return;

  const stderr = result.stderr.text;
  if (INCORRECT_PASSWORD_PATTERN.test(stderr) || /password/iu.test(stderr)) {
    throw new PdfDocumentPortError(
      "password_protected",
      "PDF password was rejected; the password may be incorrect.",
    );
  }
  if (/damaged|corrupt|invalid/iu.test(stderr) || BROKEN_PDF_STRUCTURE_PATTERN.test(stderr)) {
    throw new PdfDocumentPortError("corrupted", "PDF file is corrupted or invalid.");
  }
  const detail = [stderr, result.stdout.text, result.error?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  throw new PdfDocumentPortError(
    "process_failed",
    detail.length > 0 ? `pdftocairo failed: ${detail}` : "pdftocairo failed.",
    { cause: result.error?.cause },
  );
}

function assertRenderSucceeded(
  result: ExecutionResult,
  request: PdfDocumentRenderPagesRequest,
): void {
  if (result.cancelled) {
    throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.");
  }
  if (result.timedOut || result.status === "timed_out") {
    throw new PdfDocumentPortError(
      "timeout",
      `PDF page extraction timed out after ${READ_PDF_RENDER_TIMEOUT_MS}ms.`,
    );
  }
  if (result.status === "completed" && result.exitCode === 0) return;

  const stderr = result.stderr.text;
  const detail = [stderr, result.stdout.text, result.error?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  if (/password/iu.test(stderr)) {
    throw new PdfDocumentPortError(
      "password_protected",
      request.password
        ? "PDF password was rejected; the password may be incorrect or insufficient."
        : "PDF is password-protected. Please provide an unprotected version.",
    );
  }
  const pageRangeMatch = /Wrong page range given[\s\S]*last page \((\d+)\)/iu.exec(stderr);
  if (pageRangeMatch) {
    const documentPageCount = Number(pageRangeMatch[1]);
    if (documentPageCount === 0) {
      throw new PdfDocumentPortError(
        "corrupted",
        "PDF reports 0 pages (empty page tree). The PDF may be invalid.",
      );
    }
    if (Number.isSafeInteger(documentPageCount) && documentPageCount >= 1) {
      const requestedRange =
        request.firstPage === request.lastPage
          ? `page ${request.firstPage}`
          : `pages ${request.firstPage}-${request.lastPage}`;
      const exampleEnd = Math.min(documentPageCount, READ_PDF_MAX_PAGES_PER_REQUEST);
      throw new PdfDocumentPortError(
        "page_out_of_range",
        `Requested ${requestedRange} is outside the document (PDF has ${documentPageCount} page${documentPageCount === 1 ? "" : "s"}). Use a range within 1-${documentPageCount}, maximum ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request (e.g. pages: "1-${exampleEnd}").`,
      );
    }
  }
  const diagnosticLines = stderr.split("\n");
  const firstDiagnostic = diagnosticLines[0] ?? "";
  const hasCommandOrInternalError = diagnosticLines.some((line) =>
    /^(?:Command Line Error|Internal Error)(?: \(\d+\))?: /u.test(line),
  );
  const isInputIoError =
    firstDiagnostic.startsWith("I/O Error: ") && firstDiagnostic.includes(`'${request.filePath}'`);
  const isInputPermissionError = firstDiagnostic.startsWith("Permission Error: ");
  if ((isInputIoError || isInputPermissionError) && !hasCommandOrInternalError) {
    // 落入 process_failed，避免用宽泛关键词猜测错误类别。
    throw new PdfDocumentPortError(
      isInputPermissionError ? "permission_denied" : "io_error",
      `Could not render PDF: ${firstDiagnostic}`,
    );
  }
  // 根因：宽泛匹配 detail 会把文件名和无关诊断误判成密码、权限或损坏错误；
  // 这里只解析已知的 Poppler stderr，其余失败保留为 process_failed。
  if (/damaged|corrupt|invalid/iu.test(stderr) || BROKEN_PDF_STRUCTURE_PATTERN.test(stderr)) {
    throw new PdfDocumentPortError("corrupted", "PDF file is corrupted or invalid.");
  }
  throw new PdfDocumentPortError(
    "process_failed",
    detail.length > 0 ? `pdftoppm failed: ${detail}` : "pdftoppm failed.",
    { cause: result.error?.cause },
  );
}

/** `pdftohtml` 的失败归类：密码 / 损坏 / 其它。 */
function assertLayoutSucceeded(
  result: ExecutionResult,
  request: PdfDocumentAnalyzeLayoutRequest,
): void {
  if (result.cancelled) {
    throw new PdfDocumentPortError("cancelled", "PDF layout analysis was cancelled.");
  }
  if (result.timedOut || result.status === "timed_out") {
    throw new PdfDocumentPortError(
      "timeout",
      `PDF layout analysis timed out after ${READ_PDF_LAYOUT_TIMEOUT_MS}ms.`,
    );
  }
  if (result.status === "completed" && result.exitCode === 0) return;

  const stderr = result.stderr.text;
  if (INCORRECT_PASSWORD_PATTERN.test(stderr) || /password/iu.test(stderr)) {
    throw new PdfDocumentPortError(
      "password_protected",
      request.password
        ? "PDF password was rejected; the password may be incorrect."
        : "PDF is password-protected. A password is required to open it.",
    );
  }
  if (/damaged|corrupt|invalid/iu.test(stderr) || BROKEN_PDF_STRUCTURE_PATTERN.test(stderr)) {
    throw new PdfDocumentPortError("corrupted", "PDF file is corrupted or invalid.");
  }
  const detail = [stderr, result.stdout.text, result.error?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  throw new PdfDocumentPortError(
    "process_failed",
    detail.length > 0 ? `pdftohtml failed: ${detail}` : "pdftohtml failed.",
    { cause: result.error?.cause },
  );
}

async function readRenderedPages(
  directory: string,
  signal?: AbortSignal,
): Promise<PdfDocumentRenderedPage[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throwPdfIoError(error, signal, "Unable to list rendered PDF page images.");
  }
  const files = names
    .map((name) => ({ name, pageNumber: renderedPageNumber(name) }))
    .filter(
      (entry): entry is { name: string; pageNumber: number } => entry.pageNumber !== undefined,
    )
    .sort((left, right) => left.pageNumber - right.pageNumber);
  if (files.length === 0) {
    throw new PdfDocumentPortError(
      "corrupted",
      "pdftoppm produced no output pages. The PDF may be invalid.",
    );
  }
  try {
    return await Promise.all(
      files.map(async ({ name, pageNumber }) => ({
        data: new Uint8Array(
          await readFile(join(directory, name), signal === undefined ? undefined : { signal }),
        ),
        mediaType: "image/jpeg" as const,
        pageNumber,
      })),
    );
  } catch (error) {
    if (signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.", {
        cause: error,
      });
    }
    throw new PdfDocumentPortError("io_error", "Unable to read rendered PDF page images.", {
      cause: error,
    });
  }
}

function isAvailableProbeResult(result: ExecutionResult): boolean {
  if (result.status !== "completed" && result.status !== "failed") return false;
  return (
    result.exitCode === 0 ||
    (result.exitCode !== undefined && result.exitCode !== 127 && result.stderr.text.length > 0)
  );
}

function throwPdfIoError(error: unknown, signal: AbortSignal | undefined, message: string): never {
  if (signal?.aborted) {
    throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.", {
      cause: error,
    });
  }
  throw new PdfDocumentPortError("io_error", message, { cause: error });
}

function renderedPageNumber(name: string): number | undefined {
  const match = /-(\d+)\.jpg$/iu.exec(name);
  const pageNumber = Number(match?.[1]);
  return Number.isSafeInteger(pageNumber) && pageNumber >= 1 ? pageNumber : undefined;
}
