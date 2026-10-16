import { describe, expect, it, vi } from "vitest";
import { createSessionId, PdfDocumentPortError, SessionEventType } from "@zcode/contracts";
import { resolveTurnAttachments } from "../src/runtime/helpers/attachments.js";
import { PdfPasswordCache } from "../src/runtime/helpers/pdf-password-cache.js";
import { createPasswordAwarePdfDocumentPort } from "../src/runtime/helpers/pdf-password-port.js";
import { requestPdfPasswordViaAskUserQuestion } from "../src/runtime/methods/pdf-password-prompt.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { FileSystemPort, ImageProcessorPort } from "../src/runtime/deps.js";
import { PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE } from "../src/runtime/types.js";

type ResolveAttachmentOptions = Parameters<typeof resolveTurnAttachments>[1];

const PDF_BYTES = Buffer.from("%PDF-1.7\nlocked-body");
const PASSWORD = "pw-12345";
const WORKING_DIRECTORY = "/tmp/project";

interface Harness {
  broker: { requestPermission: ReturnType<typeof vi.fn> };
  events: Array<{ type: SessionEventType; payload: unknown }>;
  getPageCount: ReturnType<typeof vi.fn>;
  options: ResolveAttachmentOptions;
  runtime: AgentRuntimeInternal;
}

function createHarness(
  brokerResult: unknown,
  portOptions?: { alwaysFail?: boolean },
): Harness {
  const events: Array<{ type: SessionEventType; payload: unknown }> = [];
  // 未提供密码时按加密 PDF 失败；重试会携带密码并成功。
  const getPageCount = vi.fn(async (request: { password?: string }) => {
    if (!request.password) {
      throw new PdfDocumentPortError("password_protected", "Incorrect password");
    }
    if (portOptions?.alwaysFail) {
      throw new PdfDocumentPortError("password_protected", "Incorrect password");
    }
    return 1;
  });
  const renderPages = vi.fn(async () => [
    { data: new Uint8Array(64), mediaType: "image/jpeg" as const, pageNumber: 1 },
  ]);
  const fileSystemPort = {
    stat: vi.fn(async () => ({
      path: `${WORKING_DIRECTORY}/locked.pdf`,
      kind: "file" as const,
      mtimeMs: 1,
      sizeBytes: PDF_BYTES.byteLength,
    })),
    readBinaryFile: vi.fn(async () => ({
      path: `${WORKING_DIRECTORY}/locked.pdf`,
      content: PDF_BYTES,
      bytesRead: PDF_BYTES.byteLength,
      sizeBytes: PDF_BYTES.byteLength,
      revision: { id: "rev", mtimeMs: 1, sizeBytes: PDF_BYTES.byteLength, hash: "hash" },
    })),
  } as unknown as FileSystemPort;
  const imageProcessorPort = {
    prepareForModel: vi.fn(async (request: { data: Uint8Array; mediaType: string }) => ({
      data: request.data,
      mediaType: request.mediaType,
      resized: false,
      compressed: false,
      strategy: "original",
      originalSizeBytes: request.data.byteLength,
      transformedSizeBytes: request.data.byteLength,
    })),
  } as unknown as ImageProcessorPort;
  // 密码统一通道：附件链路与真实 runtime 相同——端口由装饰器包装，密码问询经
  // requestPdfPasswordViaAskUserQuestion（不再有 pdfUnlockPassword 选项）。
  const pdfPasswordCache = new PdfPasswordCache();
  const rawPort = { getPageCount, renderPages };
  const broker = { requestPermission: vi.fn(async () => brokerResult) };
  const runtime = {
    sessionId: createSessionId("pdf-decorator"),
    getMode: () => "build",
    permissionBroker: broker,
    emitPermissionRequest: vi.fn(async () => {}),
    createEvent: (type: SessionEventType, payload: unknown) => ({
      id: `event-${events.length + 1}`,
      type,
      payload,
    }),
    appendEvent: vi.fn(async (event: { type: SessionEventType; payload: unknown }) => {
      events.push({ type: event.type, payload: event.payload });
    }),
  } as unknown as AgentRuntimeInternal;
  const pdfDocumentPort = createPasswordAwarePdfDocumentPort({
    inner: rawPort,
    cache: pdfPasswordCache,
    normalizeKey: (filePath) => filePath,
    requestPassword: (request, traceContext, abortSignal) =>
      requestPdfPasswordViaAskUserQuestion.call(runtime, request, traceContext, abortSignal),
  });
  const options: ResolveAttachmentOptions = {
    artifactStore: {
      writeToolResultArtifact: vi.fn(async () => ({
        uri: "zcode-artifact://pdf-decorator-test",
        bytes: PDF_BYTES.byteLength,
        contentType: "text/plain",
        createdAt: new Date(),
        id: "pdf-decorator-test",
      })),
    } as never,
    fileSystemPort,
    imageProcessorPort,
    modelInputFormat: { supportsImage: true } as never,
    pdfDocumentPort,
    sessionId: createSessionId("pdf-decorator"),
    traceContext: { traceId: "trace_pdf_decorator", turnId: "turn-1" as never },
    workingDirectory: WORKING_DIRECTORY,
  };
  return { broker, events, getPageCount, options, runtime };
}

function answerModify(password: string) {
  return (request: { input: { questions: Array<{ question: string }> } }) => ({
    decision: "modify",
    modifiedInput: {
      answers: { [request.input.questions[0]!.question]: password },
    },
  });
}

describe("PDF attachment resolution through the password-aware port", () => {
  it("unlocks via the decorator ask and resolves page images", async () => {
    const harness = createHarness(null);
    harness.broker.requestPermission.mockImplementation(answerModify(PASSWORD));

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "locked.pdf" }], harness.options);

    expect(harness.getPageCount).toHaveBeenCalledTimes(2);
    expect(harness.getPageCount.mock.calls[1]![0]).toMatchObject({ password: PASSWORD });
    expect(resolved.metadata.pdf).toMatchObject({
      pageCount: 1,
      renderedPageCount: 1,
      renderStrategy: "page_images",
    });
    expect(resolved.metadata.errorCode).toBeUndefined();
  });

  it("keeps the placeholder when the broker denies and never retries", async () => {
    const harness = createHarness({ decision: "deny", reason: "declined" });

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "locked.pdf" }], harness.options);

    expect(harness.getPageCount).toHaveBeenCalledTimes(1);
    expect(resolved).toMatchObject({
      metadata: { errorCode: PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE },
    });
  });

  it("does not treat the Skip option as a password", async () => {
    const harness = createHarness(null);
    harness.broker.requestPermission.mockImplementation(answerModify("Skip"));

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "locked.pdf" }], harness.options);

    expect(harness.getPageCount).toHaveBeenCalledTimes(1);
    expect(resolved.metadata.errorCode).toBe(PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE);
  });

  it("keeps the placeholder after a single failed retry (no password loop)", async () => {
    const harness = createHarness(null, { alwaysFail: true });
    harness.broker.requestPermission.mockImplementation(answerModify("wrong-password"));

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "locked.pdf" }], harness.options);

    expect(harness.getPageCount).toHaveBeenCalledTimes(2);
    expect(resolved.metadata.errorCode).toBe(PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE);
  });

  it("never persists the password in permission events or broker input", async () => {
    const harness = createHarness(null);
    harness.broker.requestPermission.mockImplementation(answerModify(PASSWORD));

    await resolveTurnAttachments([{ type: "pdf", path: "locked.pdf" }], harness.options);

    const requestInput = harness.broker.requestPermission.mock.calls[0]![0] as {
      input: unknown;
      ruleId: string;
    };
    expect(JSON.stringify(requestInput.input)).not.toContain(PASSWORD);
    expect(requestInput.ruleId).toBe("pdf-password-unlock");
    expect(harness.events).toHaveLength(1);
    const resolvedEvent = harness.events[0]!;
    expect(resolvedEvent.type).toBe(SessionEventType.PermissionResolved);
    expect(JSON.stringify(resolvedEvent.payload)).not.toContain(PASSWORD);
    expect(resolvedEvent.payload).toEqual({
      toolCallId: expect.any(String),
      decision: "allow",
    });
  });

  it("leaves non-password attachments untouched when no unlock is needed", async () => {
    const harness = createHarness(null);
    // getPageCount 正常返回页数：无密码场景直接渲染页图。
    harness.getPageCount.mockResolvedValue(1);

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "plain.pdf" }], harness.options);

    expect(harness.broker.requestPermission).not.toHaveBeenCalled();
    expect(harness.events).toHaveLength(0);
    expect(resolved.metadata.pdf).toMatchObject({ renderStrategy: "page_images" });
  });
});
