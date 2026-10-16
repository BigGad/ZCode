import { describe, expect, it, vi } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import { emitTurnAttachmentPageCounts } from "../src/runtime/methods/turn-attachment-page-counts.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ResolvedTurnAttachment } from "../src/runtime/types.js";

interface Harness {
  events: Array<{ type: SessionEventType; payload: unknown }>;
  runtime: AgentRuntimeInternal;
}

function createHarness(): Harness {
  const events: Array<{ type: SessionEventType; payload: unknown }> = [];
  const runtime = {
    createEvent: (type: SessionEventType, payload: unknown) => ({
      id: `event-${events.length + 1}`,
      type,
      payload,
    }),
    appendEvent: vi.fn(async (event: { type: SessionEventType; payload: unknown }) => {
      events.push({ type: event.type, payload: event.payload });
    }),
  } as unknown as AgentRuntimeInternal;
  return { events, runtime };
}

function pdfAttachment(pageCount?: number): ResolvedTurnAttachment {
  return {
    contentBlock: { type: "text", text: "pdf" },
    metadata: {
      ...(pageCount === undefined ? {} : { pdf: { pageCount, renderStrategy: "page_images" } }),
      sizeBytes: 1024,
    },
    mime: "application/pdf",
    url: "/tmp/doc.pdf",
  };
}

function imageAttachment(): ResolvedTurnAttachment {
  return {
    contentBlock: { type: "text", text: "img" },
    metadata: { sizeBytes: 512 },
    mime: "image/png",
    url: "/tmp/img.png",
  };
}

describe("emitTurnAttachmentPageCounts", () => {
  it("does not emit when no attachment carries a page count", async () => {
    const harness = createHarness();
    await emitTurnAttachmentPageCounts.call(harness.runtime, {
      messageId: "user-1" as never,
      resolved: [imageAttachment(), pdfAttachment()],
      traceContext: { traceId: "trace" } as never,
      turnId: "turn-1" as never,
    });
    expect(harness.events).toEqual([]);
  });

  it("emits index-aligned updates only for PDFs with a positive page count", async () => {
    const harness = createHarness();
    await emitTurnAttachmentPageCounts.call(harness.runtime, {
      messageId: "user-1" as never,
      resolved: [pdfAttachment(12), imageAttachment(), pdfAttachment(3)],
      traceContext: { traceId: "trace" } as never,
      turnId: "turn-1" as never,
    });
    expect(harness.events).toHaveLength(1);
    const [event] = harness.events;
    expect(event?.type).toBe(SessionEventType.TurnAttachmentMetaUpdated);
    // index 对齐 resolve 顺序；image 与无页数 PDF 不进入 updates。
    expect(event?.payload).toEqual({
      turnId: "turn-1",
      messageId: "user-1",
      updates: [
        { index: 0, pageCount: 12 },
        { index: 2, pageCount: 3 },
      ],
    });
  });

  it("omits turnId when absent and rejects non-positive page counts", async () => {
    const harness = createHarness();
    await emitTurnAttachmentPageCounts.call(harness.runtime, {
      messageId: "user-2" as never,
      resolved: [pdfAttachment(0), pdfAttachment(-1), pdfAttachment(2.5)],
      traceContext: { traceId: "trace" } as never,
    });
    expect(harness.events).toEqual([]);
  });

  it("emits for a single PDF page count without turnId-less event suppression", async () => {
    const harness = createHarness();
    await emitTurnAttachmentPageCounts.call(harness.runtime, {
      messageId: "user-3" as never,
      resolved: [pdfAttachment(4)],
      traceContext: { traceId: "trace" } as never,
    });
    expect(harness.events).toHaveLength(1);
  });
});
