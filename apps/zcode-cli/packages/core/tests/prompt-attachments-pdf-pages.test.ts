import { describe, expect, it, vi } from "vitest";
import { createSessionId, PdfDocumentPortError } from "@zcode/contracts";
import { resolveTurnAttachments } from "../src/runtime/helpers/attachments.js";
import { buildUserContentFromTurn } from "../src/runtime/helpers/conversation.js";
import {
  PDF_ATTACHMENT_MAX_RENDERED_PAGES,
  PDF_ATTACHMENT_PAGE_IMAGES_BUDGET_BYTES,
} from "../src/runtime/helpers/attachment-pdf-pages.js";
import { PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE } from "../src/runtime/types.js";
import type { FileSystemPort, ImageProcessorPort, PdfDocumentPort } from "../src/runtime/deps.js";

const PDF_BYTES = Buffer.from("%PDF-1.7\nwatermarked-body");

function fakeWriteToolResultArtifact() {
  return vi.fn(async () => ({
    uri: "zcode-artifact://pdf-pages-test",
    bytes: PDF_BYTES.byteLength,
    contentType: "text/plain",
    createdAt: new Date(),
    id: "pdf-pages-test",
  }));
}

function visionFormat() {
  return { supportsImage: true } as never;
}

function fakePdfDocumentPort(overrides: {
  pageCount?: number;
  renderError?: Error;
  renderPages?: ReturnType<typeof vi.fn>;
} = {}): PdfDocumentPort & { renderPages: ReturnType<typeof vi.fn>; getPageCount: ReturnType<typeof vi.fn> } {
  const pageCount = overrides.pageCount ?? 2;
  const getPageCount = vi.fn(async () => pageCount);
  const renderPages =
    overrides.renderPages ??
    vi.fn(async (request: { firstPage: number; lastPage: number }) =>
      renderJpegPages(request.firstPage, request.lastPage),
    );
  if (overrides.renderError) {
    renderPages.mockRejectedValue(overrides.renderError);
  }
  return { getPageCount, renderPages } as never;
}

function renderJpegPages(firstPage: number, lastPage: number, pageSizeBytes = 64) {
  const pages = [];
  for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
    pages.push({
      data: new Uint8Array(pageSizeBytes),
      mediaType: "image/jpeg" as const,
      pageNumber,
    });
  }
  return pages;
}

function fakeImageProcessorPort(prepareForModel?: ReturnType<typeof vi.fn>) {
  const prepare =
    prepareForModel ??
    vi.fn(async (request: { data: Uint8Array; mediaType: string }) => ({
      data: request.data,
      mediaType: request.mediaType,
      resized: false,
      originalWidth: 800,
      originalHeight: 1000,
      width: 800,
      height: 1000,
      compressed: false,
      strategy: "original",
      originalSizeBytes: request.data.byteLength,
      transformedSizeBytes: request.data.byteLength,
    }));
  return { prepareForModel: prepare } as unknown as ImageProcessorPort & {
    prepareForModel: ReturnType<typeof vi.fn>;
  };
}

function localPdfFileSystemPort() {
  const path = "/tmp/project/watermark.pdf";
  const fileSystemPort = {
    stat: vi.fn(async () => ({
      path,
      kind: "file" as const,
      mtimeMs: 1,
      sizeBytes: PDF_BYTES.byteLength,
    })),
    readBinaryFile: vi.fn(async () => ({
      path,
      content: PDF_BYTES,
      bytesRead: PDF_BYTES.byteLength,
      sizeBytes: PDF_BYTES.byteLength,
      revision: { id: "rev", mtimeMs: 1, sizeBytes: PDF_BYTES.byteLength, hash: "hash" },
    })),
  } as unknown as FileSystemPort & { stat: ReturnType<typeof vi.fn>; readBinaryFile: ReturnType<typeof vi.fn> };
  return { fileSystemPort, path };
}

describe("PDF attachment page-image rendering", () => {
  it("renders page images for a vision-capable model and keeps the fallback file block", async () => {
    const { fileSystemPort, path } = localPdfFileSystemPort();
    const writeToolResultArtifact = vi.fn(async () => ({
      uri: "zcode-artifact://pdf-pages-1",
      bytes: PDF_BYTES.byteLength,
      contentType: "text/plain",
      createdAt: new Date(),
      id: "pdf-pages-1",
    }));
    const pdfDocumentPort = fakePdfDocumentPort({ pageCount: 2 });

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "watermark.pdf" }], {
      artifactStore: { writeToolResultArtifact } as never,
      fileSystemPort,
      imageProcessorPort: fakeImageProcessorPort(),
      modelInputFormat: visionFormat(),
      pdfDocumentPort,
      sessionId: createSessionId("pdf-pages-local"),
      traceContext: { traceId: "trace_pdf_pages_local" },
      workingDirectory: "/tmp/project",
    });

    expect(pdfDocumentPort.renderPages).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: path, firstPage: 1, lastPage: 2 }),
      expect.any(Object),
    );
    expect(resolved.contentBlocks).toHaveLength(3);
    const [page1, page2, trailer] = resolved.contentBlocks!;
    expect(page1).toMatchObject({
      type: "image",
      mediaType: "image/jpeg",
      source: { id: "turn-attachment-1-page-1", kind: "inline" },
    });
    expect(page2).toMatchObject({
      type: "image",
      source: { id: "turn-attachment-1-page-2", kind: "inline" },
    });
    expect(trailer).toMatchObject({ type: "text" });
    expect((trailer as { text: string }).text).toContain(path);
    expect((trailer as { text: string }).text).toContain("All pages are attached");
    expect(resolved.contentBlock.type).toBe("file");
    expect(resolved.metadata).toMatchObject({
      pdf: { pageCount: 2, renderedPageCount: 2, renderStrategy: "page_images" },
      storageKind: "local_ref",
    });
    expect(writeToolResultArtifact).toHaveBeenCalledOnce();
  });

  it("keeps the plain file block when the model has no vision support", async () => {
    const { fileSystemPort, path } = localPdfFileSystemPort();
    const pdfDocumentPort = fakePdfDocumentPort();

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "watermark.pdf" }], {
      artifactStore: { writeToolResultArtifact: fakeWriteToolResultArtifact() } as never,
      fileSystemPort,
      imageProcessorPort: fakeImageProcessorPort(),
      modelInputFormat: { supportsImage: false } as never,
      pdfDocumentPort,
      sessionId: createSessionId("pdf-pages-novision"),
      traceContext: { traceId: "trace_pdf_pages_novision" },
      workingDirectory: "/tmp/project",
    });

    expect(pdfDocumentPort.renderPages).not.toHaveBeenCalled();
    expect(resolved.contentBlocks).toBeUndefined();
    expect(resolved.metadata.pdf).toBeUndefined();
    expect(resolved).toMatchObject({
      contentBlock: { type: "file", source: { kind: "local_file", path } },
      metadata: { storageKind: "artifact" },
    });
  });

  it("falls back to the file block when page rendering fails with a non-password error", async () => {
    const { fileSystemPort, path } = localPdfFileSystemPort();

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "watermark.pdf" }], {
      artifactStore: { writeToolResultArtifact: fakeWriteToolResultArtifact() } as never,
      fileSystemPort,
      imageProcessorPort: fakeImageProcessorPort(),
      modelInputFormat: visionFormat(),
      pdfDocumentPort: fakePdfDocumentPort({
        renderError: new PdfDocumentPortError("process_failed", "poppler exploded"),
      }),
      sessionId: createSessionId("pdf-pages-io-fallback"),
      traceContext: { traceId: "trace_pdf_pages_io_fallback" },
      workingDirectory: "/tmp/project",
    });

    expect(resolved.contentBlocks).toBeUndefined();
    expect(resolved.metadata.errorCode).toBeUndefined();
    expect(resolved).toMatchObject({
      contentBlock: { type: "file", source: { kind: "local_file", path } },
    });
  });

  it("surfaces a password placeholder for password-protected PDFs", async () => {
    const { fileSystemPort } = localPdfFileSystemPort();
    const getPageCount = vi.fn(async () => {
      throw new PdfDocumentPortError("password_protected", "Incorrect password");
    });

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "secret.pdf" }], {
      artifactStore: { writeToolResultArtifact: fakeWriteToolResultArtifact() } as never,
      fileSystemPort,
      imageProcessorPort: fakeImageProcessorPort(),
      modelInputFormat: visionFormat(),
      pdfDocumentPort: { getPageCount, renderPages: vi.fn() } as never,
      sessionId: createSessionId("pdf-pages-locked"),
      traceContext: { traceId: "trace_pdf_pages_locked" },
      workingDirectory: "/tmp/project",
    });

    expect(resolved).toMatchObject({
      contentBlock: { type: "text", text: "[Attached application/pdf: secret.pdf]" },
      metadata: { errorCode: PDF_PASSWORD_PROTECTED_ATTACHMENT_ERROR_CODE },
    });
  });

  it("stops rendering at the per-attachment byte budget and guides continuation via the trailer", async () => {
    const { fileSystemPort, path } = localPdfFileSystemPort();
    const bigPage = new Uint8Array(PDF_ATTACHMENT_PAGE_IMAGES_BUDGET_BYTES);
    const renderPages = vi.fn(async (request: { firstPage: number; lastPage: number }) => [
      { data: new Uint8Array(64), mediaType: "image/jpeg" as const, pageNumber: 1 },
      { data: bigPage, mediaType: "image/jpeg" as const, pageNumber: 2 },
      { data: bigPage, mediaType: "image/jpeg" as const, pageNumber: 3 },
    ]);

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "watermark.pdf" }], {
      artifactStore: { writeToolResultArtifact: fakeWriteToolResultArtifact() } as never,
      fileSystemPort,
      imageProcessorPort: fakeImageProcessorPort(),
      modelInputFormat: visionFormat(),
      pdfDocumentPort: fakePdfDocumentPort({ pageCount: 3, renderPages }),
      sessionId: createSessionId("pdf-pages-budget"),
      traceContext: { traceId: "trace_pdf_pages_budget" },
      workingDirectory: "/tmp/project",
    });

    expect(resolved.metadata.pdf).toMatchObject({
      pageCount: 3,
      renderedPageCount: 1,
      renderStrategy: "page_images",
    });
    const trailer = resolved.contentBlocks!.at(-1) as { type: "text"; text: string };
    expect(trailer.text).toContain("Only the first 1 page(s)");
    expect(trailer.text).toContain(`pages: "2-3"`);
    expect(trailer.text).toContain(path);
  });

  it("caps rendered pages at the shared page limit", async () => {
    const { fileSystemPort } = localPdfFileSystemPort();
    const renderPages = vi.fn(async (request: { firstPage: number; lastPage: number }) =>
      renderJpegPages(request.firstPage, request.lastPage),
    );

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "watermark.pdf" }], {
      artifactStore: { writeToolResultArtifact: fakeWriteToolResultArtifact() } as never,
      fileSystemPort,
      imageProcessorPort: fakeImageProcessorPort(),
      modelInputFormat: visionFormat(),
      pdfDocumentPort: fakePdfDocumentPort({ pageCount: 50, renderPages }),
      sessionId: createSessionId("pdf-pages-cap"),
      traceContext: { traceId: "trace_pdf_pages_cap" },
      workingDirectory: "/tmp/project",
    });

    expect(renderPages).toHaveBeenCalledWith(
      expect.objectContaining({ firstPage: 1, lastPage: PDF_ATTACHMENT_MAX_RENDERED_PAGES }),
      expect.any(Object),
    );
    expect(resolved.metadata.pdf).toMatchObject({
      pageCount: 50,
      renderedPageCount: PDF_ATTACHMENT_MAX_RENDERED_PAGES,
    });
  });
});

describe("inline PDF page-image rendering", () => {
  function inlinePdfDataUrl() {
    return `data:application/pdf;base64,${Buffer.from(PDF_BYTES).toString("base64")}`;
  }

  function inlineArtifactStore(ensure: "ready" | "unsupported" | "missing" | "throws") {
    const ensureMediaAttachmentPath =
      ensure === "missing"
        ? undefined
        : vi.fn(async () =>
            ensure === "ready"
              ? ({ status: "ready", path: "/tmp/cache/pdf-cache/session/report.pdf" } as const)
              : ensure === "unsupported"
                ? ({ status: "unsupported" } as const)
                : (() => {
                    throw new Error("materialize failed");
                  })(),
          );
    return {
      ensureMediaAttachmentPath,
      writeToolResultArtifact: vi.fn(async () => ({
        uri: "zcode-artifact://pdf-inline-pages-1",
        bytes: 128,
        contentType: "text/plain",
        createdAt: new Date(),
        id: "pdf-inline-pages-1",
      })),
    };
  }

  it("materializes a derived path and renders page images", async () => {
    const artifactStore = inlineArtifactStore("ready");
    const pdfDocumentPort = fakePdfDocumentPort({ pageCount: 1 });

    const [resolved] = await resolveTurnAttachments(
      [{ type: "pdf", filename: "report.pdf", content: inlinePdfDataUrl() }],
      {
        artifactStore: artifactStore as never,
        imageProcessorPort: fakeImageProcessorPort(),
        modelInputFormat: visionFormat(),
        pdfDocumentPort,
        sessionId: createSessionId("pdf-pages-inline"),
        traceContext: { traceId: "trace_pdf_pages_inline" },
        workingDirectory: "/tmp/project",
      },
    );

    expect(artifactStore.ensureMediaAttachmentPath).toHaveBeenCalledWith({
      mediaType: "application/pdf",
      uri: "zcode-artifact://pdf-inline-pages-1",
    });
    expect(pdfDocumentPort.renderPages).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/tmp/cache/pdf-cache/session/report.pdf" }),
      expect.any(Object),
    );
    expect(resolved.contentBlocks).toHaveLength(2);
    expect(resolved.metadata.pdf).toMatchObject({
      pageCount: 1,
      renderedPageCount: 1,
      renderStrategy: "page_images",
    });
  });

  it.each(["unsupported", "missing", "throws"] as const)(
    "falls back to the file block when the derived path is unavailable: %s",
    async (mode) => {
      const artifactStore = inlineArtifactStore(mode);
      const pdfDocumentPort = fakePdfDocumentPort();

      const [resolved] = await resolveTurnAttachments(
        [{ type: "pdf", filename: "report.pdf", content: inlinePdfDataUrl() }],
        {
          artifactStore: artifactStore as never,
          imageProcessorPort: fakeImageProcessorPort(),
          modelInputFormat: visionFormat(),
          pdfDocumentPort,
          sessionId: createSessionId("pdf-pages-inline-fallback"),
          traceContext: { traceId: "trace_pdf_pages_inline_fallback" },
          workingDirectory: "/tmp/project",
        },
      );

      expect(pdfDocumentPort.renderPages).not.toHaveBeenCalled();
      expect(resolved.contentBlocks).toBeUndefined();
      expect(resolved).toMatchObject({
        contentBlock: { type: "file", dataUrl: inlinePdfDataUrl() },
        metadata: { storageKind: "artifact" },
      });
    },
  );
});

describe("multi-block attachment consumption", () => {
  it("expands contentBlocks in buildUserContentFromTurn in attachment order", async () => {
    const { fileSystemPort } = localPdfFileSystemPort();

    const [resolved] = await resolveTurnAttachments([{ type: "pdf", path: "watermark.pdf" }], {
      artifactStore: { writeToolResultArtifact: fakeWriteToolResultArtifact() } as never,
      fileSystemPort,
      imageProcessorPort: fakeImageProcessorPort(),
      modelInputFormat: visionFormat(),
      pdfDocumentPort: fakePdfDocumentPort({ pageCount: 1 }),
      sessionId: createSessionId("pdf-pages-consume"),
      traceContext: { traceId: "trace_pdf_pages_consume" },
      workingDirectory: "/tmp/project",
    });

    const content = buildUserContentFromTurn("summarize this", [resolved]);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Extract<typeof content, readonly unknown[]>;
    const types = blocks.map((block) => (block as { type: string }).type);
    expect(types).toEqual(["image", "text", "text"]);
    const trailing = blocks.at(-1) as { text: string };
    expect(trailing.text).toBe("summarize this");
    const trailer = blocks[1] as { text: string };
    expect(trailer.text).toContain("All pages are attached");
  });
});
