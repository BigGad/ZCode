import { PdfDocumentPortError, SessionEventType, type EventId } from "@zcode/contracts";
import { resolve } from "node:path";
import type { PdfReadProgressMap, ToolExecutionContext } from "../types.js";

/**
 * Read 工具 PDF 分页阅读进度（见 message-attachments.md「PDF 密码统一通道与阅读进度」节）。
 *
 * 所有者：runtime 持有 `pdfReadProgress`（按引用共享进 executor），read-pdf.ts 是唯一
 * 写入者；已识别页跨 Read 调用累加（同一文件多次 `pages` 读取）。进度经 `ToolCallProgress`
 * transient 事件发射（不持久化），UI 只做展示投影，终态（result/error）清除。
 */

/** key = 规范化绝对路径，与 PdfPasswordCache 的 normalizeKey 语义一致。 */
function pdfReadProgressKey(workingDirectory: string, filePath: string): string {
  return resolve(workingDirectory, filePath);
}

function recordPdfPagesRecognized(
  map: PdfReadProgressMap,
  key: string,
  pageCount: number | undefined,
  pageNumbers: readonly number[],
): { recognized: number; total?: number } {
  const entry = map.get(key) ?? { recognizedPages: new Set<number>() };
  for (const pageNumber of pageNumbers) entry.recognizedPages.add(pageNumber);
  if (pageCount !== undefined) entry.pageCount = pageCount;
  map.set(key, entry);
  return {
    recognized: entry.recognizedPages.size,
    ...(entry.pageCount !== undefined ? { total: entry.pageCount } : {}),
  };
}

const PDF_READ_PROGRESS_TOOL_NAME = "Read";

async function emitReadPdfProgress(
  context: ToolExecutionContext,
  payload: { progress?: number; total?: number; message: string },
): Promise<void> {
  if (!context.emitEvent) return;
  await context.emitEvent({
    // 与 bash.ts emitProgressEvent 同构：sequenceNumber 由 reducer 侧补齐。
    id: crypto.randomUUID() as EventId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId,
      toolName: PDF_READ_PROGRESS_TOOL_NAME,
      ...(payload.progress !== undefined ? { progress: payload.progress } : {}),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      message: payload.message,
    },
  });
}

/**
 * 渲染前探测总页数并发射开始进度。探测失败（含 port 缺席）降级：省略 total，
 * 不阻断阅读——密码问询由端口装饰器负责，这里只吞掉探测类失败。
 * 例外：password_protected 必须上抛——Skip 后若吞掉，renderPages 会在装饰器里
 * 再次问询，用户会被弹窗两次。
 */
export async function announcePdfPageReadStart(
  context: ToolExecutionContext,
  filePath: string,
  trace: ToolExecutionContext["traceContext"],
  range: { firstPage: number; lastPage: number },
): Promise<number | undefined> {
  let total: number | undefined;
  if (context.pdfDocumentPort) {
    try {
      total = await context.pdfDocumentPort.getPageCount(
        { filePath, trace: trace! },
        { signal: context.abortSignal },
      );
    } catch (error) {
      if (error instanceof PdfDocumentPortError && error.code === "password_protected") {
        throw error;
      }
      total = undefined;
    }
  }
  const span = `第 ${range.firstPage}-${range.lastPage} 页`;
  await emitReadPdfProgress(context, {
    ...(total !== undefined ? { total } : {}),
    message: total !== undefined ? `${span} / 共 ${total} 页` : span,
  });
  return total;
}

/** 页图准备完成后：累计已识别页并发完成进度。 */
export async function announcePdfPagesRecognized(
  context: ToolExecutionContext,
  filePath: string,
  total: number | undefined,
  pageNumbers: readonly number[],
): Promise<void> {
  if (!context.pdfReadProgress) return;
  const key = pdfReadProgressKey(context.workingDirectory, filePath);
  const { recognized } = recordPdfPagesRecognized(
    context.pdfReadProgress,
    key,
    total,
    pageNumbers,
  );
  const span = `第 ${Math.min(...pageNumbers)}-${Math.max(...pageNumbers)} 页完成`;
  await emitReadPdfProgress(context, {
    progress: recognized,
    ...(total !== undefined ? { total } : {}),
    message:
      total !== undefined
        ? `已识别 ${recognized}/${total} 页 · ${span}`
        : `已识别 ${recognized} 页 · ${span}`,
  });
}
