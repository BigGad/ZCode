import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  DELIVERY_PROFILES,
  conversationDeltaSchema,
  filterConversationDeltasForProfile,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

/**
 * Read 阅读进度投影（message-attachments.md「PDF 密码统一通道与阅读进度」）：
 * read-pdf.ts 发 ToolCallProgress（toolName "Read"，progress/total/message），
 * 走 product-projection 的通用 MCP 百分比分支；Bash 尾窗分支不受影响；
 * 终态事件清除进度（R7）。
 */
function harness(toolName: "Read" | "Bash") {
  const projection = new ProductProjection(`pdf-progress-${toolName}`, "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "pdf-progress",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "阅卷", messageId: "user-1" });
  apply(SessionEventType.ToolCallScheduled, {
    toolCallId: "tool-1",
    toolName,
    input: toolName === "Read" ? { filePath: "/doc.pdf", pages: "1-20" } : { command: "build" },
    schedule: { parallelGroups: [["tool-1"]], executionOrder: ["tool-1"] },
  });
  apply(SessionEventType.ToolCallStarted, { toolCallId: "tool-1", toolName });
  const row = () =>
    projection.getSnapshot().rows.window.find((r) => r.kind === "toolCall") as ToolCallRow;
  return { apply, projection, row };
}

describe("Read PDF progress product projection", () => {
  it("projects progress, total and message onto the running Read row", () => {
    const h = harness("Read");
    const deltas = h.apply(SessionEventType.ToolCallProgress, {
      toolCallId: "tool-1",
      toolName: "Read",
      progress: 20,
      total: 42,
      message: "已识别 20/42 页 · 第 1-20 页完成",
    });
    const progress = h.row().progress;
    expect(progress?.total).toBe(42);
    expect(progress?.message).toBe("已识别 20/42 页 · 第 1-20 页完成");
    expect(progress?.fraction).toBeCloseTo(20 / 42, 6);
    expect(deltas.some((delta) => delta.op === "row.upserted")).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
    for (const profile of Object.values(DELIVERY_PROFILES)) {
      expect(filterConversationDeltasForProfile(deltas, profile)).toEqual(deltas);
    }
  });

  it("degrades to message-only progress when total probing is unavailable", () => {
    const h = harness("Read");
    h.apply(SessionEventType.ToolCallProgress, {
      toolCallId: "tool-1",
      toolName: "Read",
      progress: 20,
      message: "第 1-20 页完成",
    });
    const progress = h.row().progress;
    expect(progress?.fraction).toBeUndefined();
    expect(progress?.total).toBeUndefined();
    expect(progress?.message).toBe("第 1-20 页完成");
  });

  it("clears progress on terminal events and rejects late progress", () => {
    const h = harness("Read");
    h.apply(SessionEventType.ToolCallProgress, {
      toolCallId: "tool-1",
      toolName: "Read",
      progress: 20,
      total: 42,
      message: "已识别 20/42 页",
    });
    h.apply(SessionEventType.ToolCallResult, {
      toolCallId: "tool-1",
      result: { success: true, content: "pages rendered" },
      duration: 1,
    });
    expect(h.row().progress).toBeUndefined();
    // 终态之后迟到的进度通知不能重新点亮成功行（R7）。
    expect(
      h.apply(SessionEventType.ToolCallProgress, {
        toolCallId: "tool-1",
        toolName: "Read",
        progress: 42,
        total: 42,
        message: "late",
      }),
    ).toEqual([]);
    expect(h.row().progress).toBeUndefined();
  });

  it("keeps the Bash tail-window branch unchanged for Read-style progress payloads", () => {
    const h = harness("Bash");
    h.apply(SessionEventType.ToolCallProgress, {
      toolCallId: "tool-1",
      toolName: "Bash",
      outputPreview: {
        text: "latest",
        fullText: "latest",
        totalBytes: 10,
        totalLines: 1,
        linesEstimated: false,
      },
    });
    // Bash 分支只投影 outputPreview，不写 progress（避免两个分支互相覆盖）。
    expect(h.row().outputPreview?.text).toBe("latest");
    expect(h.row().progress).toBeUndefined();
  });
});
