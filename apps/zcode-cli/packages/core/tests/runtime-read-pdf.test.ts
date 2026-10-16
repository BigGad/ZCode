import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  PdfDocumentPortError,
  SessionEventType,
  type FileSystemPort,
  type ImageProcessorPort,
  type ModelRequest,
  type PdfDocumentPort,
  type SessionEvent,
  type SessionEventStorePort,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const WORKSPACE_PATH = join(tmpdir(), "zcode-runtime-read-pdf");
const PDF_PATH = join(WORKSPACE_PATH, "report.pdf");
const PDF_CONTENT = new Uint8Array(Buffer.from("%PDF-1.7\nfixture"));
const PDF_PASSWORD = "pw-runtime-read-pdf";
const TOOL_CALL_ID = "read-pdf";

describe.each(["interactive", "subagent_child"] as const)(
  "AgentRuntime PDF dependency wiring (%s)",
  (taskType) => {
    it("returns rendered page images to the model through the injected PDF port", async () => {
      const renderPages = vi.fn<PdfDocumentPort["renderPages"]>(async () =>
        [2, 3].map((pageNumber) => ({
          pageNumber,
          data: new Uint8Array(Buffer.from(`page-${pageNumber}`)),
          mediaType: "image/jpeg",
        })),
      );
      const getPageCount = vi.fn<PdfDocumentPort["getPageCount"]>();
      const { requests, readBinaryFile } = await executePdfRead(taskType, {
        pages: "2-3",
        pdfDocumentPort: { getPageCount, renderPages },
      });

      expect(renderPages).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ filePath: PDF_PATH, firstPage: 2, lastPage: 3 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      // 阅读进度探测：pages 分支渲染前会 getPageCount 一次（失败降级省略 total）。
      expect(getPageCount).toHaveBeenCalledTimes(1);
      expect(readBinaryFile).not.toHaveBeenCalled();
      const toolResult = requests[1]?.messages.find(
        (message) => message.role === "tool" && message.toolCallId === TOOL_CALL_ID,
      );
      expect(toolResult).toMatchObject({ role: "tool", toolName: "Read", isError: false });
      expect(toolResult?.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("PDF pages extracted: 2 page(s)"),
        }),
        ...[2, 3].map((pageNumber) =>
          expect.objectContaining({
            type: "image",
            mediaType: "image/jpeg",
            dataUrl: `data:image/jpeg;base64,${Buffer.from(`page-${pageNumber}`).toString("base64")}`,
          }),
        ),
      ]);
    });

    it("checks the page count before sending a whole PDF to the model", async () => {
      const getPageCount = vi.fn<PdfDocumentPort["getPageCount"]>(async () => 11);
      const renderPages = vi.fn<PdfDocumentPort["renderPages"]>();
      const { requests, readBinaryFile } = await executePdfRead(taskType, {
        pdfDocumentPort: { getPageCount, renderPages },
      });

      expect(getPageCount).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ filePath: PDF_PATH }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(renderPages).not.toHaveBeenCalled();
      expect(readBinaryFile).not.toHaveBeenCalled();
      expect(
        requests[1]?.messages.find(
          (message) => message.role === "tool" && message.toolCallId === TOOL_CALL_ID,
        ),
      ).toMatchObject({
        isError: true,
        content: expect.stringContaining(
          "This PDF has 11 pages, which is too many to read at once",
        ),
      });
    });

    it("unlocks a password PDF via the decorator ask and emits Read progress events", async () => {
      const lockedPort = (): PdfDocumentPort => ({
        getPageCount: vi.fn<PdfDocumentPort["getPageCount"]>(async (request) => {
          if (!request.password) {
            throw new PdfDocumentPortError("password_protected", "locked");
          }
          return 4;
        }),
        renderPages: vi.fn<PdfDocumentPort["renderPages"]>(async (request) => {
          if (!request.password) {
            throw new PdfDocumentPortError("password_protected", "locked");
          }
          return Array.from(
            { length: request.lastPage - request.firstPage + 1 },
            (_, offset) => {
              const pageNumber = request.firstPage + offset;
              return {
                pageNumber,
                data: new Uint8Array(Buffer.from(`page-${pageNumber}`)),
                mediaType: "image/jpeg" as const,
              };
            },
          );
        }),
      });
      const pdfDocumentPort = lockedPort();
      const events: SessionEvent[] = [];
      const eventStore = createTestSessionEventStore();
      const originalAppend = eventStore.append.bind(eventStore);
      eventStore.append = async (event) => {
        events.push(event);
        return originalAppend(event);
      };
      const permissionBroker = {
        requestPermission: vi.fn(async (request: never) => {
          const questions = (request as { input: { questions: Array<{ question: string }> } })
            .input.questions;
          return {
            decision: "modify",
            modifiedInput: { answers: { [questions[0]!.question]: PDF_PASSWORD } },
          };
        }),
      };
      const { requests } = await executePdfRead(taskType, {
        pages: "1-2",
        pdfDocumentPort,
        eventStore,
        permissionBroker,
      });

      // 装饰器：探测（无密码失败）→ 问询 → 带密码重试成功；renderPages 同样带密码。
      expect(pdfDocumentPort.getPageCount).toHaveBeenCalledTimes(2);
      expect(pdfDocumentPort.getPageCount.mock.calls[1]![0]).toMatchObject({
        password: PDF_PASSWORD,
      });
      // renderPages 第一次无密码失败（缓存已由探测段建立）→ 第二次带密码成功。
      expect(pdfDocumentPort.renderPages).toHaveBeenCalledTimes(2);
      expect(pdfDocumentPort.renderPages.mock.calls[1]![0]).toMatchObject({
        password: PDF_PASSWORD,
      });
      const toolResult = requests[1]?.messages.find(
        (message) => message.role === "tool" && message.toolCallId === TOOL_CALL_ID,
      );
      expect(toolResult).toMatchObject({ role: "tool", toolName: "Read", isError: false });

      // 进度事件（transient）：开始段 + 完成段；密码不出现在任何事件里。
      const progressEvents = events.filter(
        (event) => event.type === SessionEventType.ToolCallProgress,
      );
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);
      expect(progressEvents[0]?.payload).toMatchObject({
        toolName: "Read",
        total: 4,
        message: "第 1-2 页 / 共 4 页",
      });
      const completion = progressEvents.at(-1)?.payload as { progress?: number; total?: number };
      expect(completion).toMatchObject({ progress: 2, total: 4 });
      expect(JSON.stringify(events)).not.toContain(PDF_PASSWORD);
    });

    it("fast-fails a password PDF with a clean error when the broker denies", async () => {
      const getPageCount = vi.fn<PdfDocumentPort["getPageCount"]>(async () => {
        throw new PdfDocumentPortError("password_protected", "locked");
      });
      const renderPages = vi.fn<PdfDocumentPort["renderPages"]>();
      const { requests } = await executePdfRead(taskType, {
        pages: "1-2",
        pdfDocumentPort: { getPageCount, renderPages },
      });

      // deny broker（测试默认 broker）→ 装饰器原样上抛，不重试不循环。
      expect(getPageCount).toHaveBeenCalledTimes(1);
      expect(renderPages).not.toHaveBeenCalled();
      expect(
        requests[1]?.messages.find(
          (message) => message.role === "tool" && message.toolCallId === TOOL_CALL_ID,
        ),
      ).toMatchObject({
        isError: true,
        content: expect.stringContaining("locked"),
      });
    });
  },
);

async function executePdfRead(
  taskType: "interactive" | "subagent_child",
  options: {
    pages?: string;
    pdfDocumentPort: PdfDocumentPort;
    eventStore?: SessionEventStorePort;
    permissionBroker?: unknown;
  },
) {
  const requests: ModelRequest[] = [];
  const readBinaryFile = vi.fn<FileSystemPort["readBinaryFile"]>(async (request) => ({
    path: request.path,
    content: PDF_CONTENT,
    bytesRead: PDF_CONTENT.byteLength,
    sizeBytes: PDF_CONTENT.byteLength,
  }));
  const fileSystemPort = {
    stat: vi.fn<FileSystemPort["stat"]>(async (request) => ({
      path: request.path,
      kind: "file",
      sizeBytes: PDF_CONTENT.byteLength,
    })),
    readBinaryFile,
  } as unknown as FileSystemPort;
  const imageProcessorPort: ImageProcessorPort = {
    resizeToFit: vi.fn<ImageProcessorPort["resizeToFit"]>(),
    async prepareForModel(request) {
      return {
        data: request.data,
        mediaType: request.mediaType,
        originalSizeBytes: request.data.byteLength,
        transformedSizeBytes: request.data.byteLength,
        resized: false,
        compressed: false,
        strategy: "original",
      };
    },
  };
  const runtime = createTestAgentRuntime(
    createSessionId(`runtime-read-pdf-${taskType}`),
    {
      taskType,
      mode: "build",
      modelStreaming: "off",
      workingDirectory: WORKSPACE_PATH,
      memory: { enabled: false },
      compact: { enabled: false },
    },
    {
      eventStore: options.eventStore ?? createTestSessionEventStore(),
      fileSystemPort,
      imageProcessorPort,
      pdfDocumentPort: options.pdfDocumentPort,
      ...(options.permissionBroker === undefined ? {} : { permissionBroker: options.permissionBroker }),
      modelFactory: createTestModelFactory({
        async generateText(request) {
          requests.push(request);
          return requests.length === 1
            ? {
                finishReason: "tool-calls",
                text: "",
                toolCalls: [
                  {
                    id: TOOL_CALL_ID,
                    name: "Read",
                    input: {
                      file_path: PDF_PATH,
                      ...(options.pages === undefined ? {} : { pages: options.pages }),
                    },
                  },
                ],
                usage: {},
              }
            : { finishReason: "stop", text: "done", usage: {} };
        },
      }),
    },
  );

  await runtime.executeTurn("Read the PDF");
  expect(requests).toHaveLength(2);
  return { requests, readBinaryFile };
}
