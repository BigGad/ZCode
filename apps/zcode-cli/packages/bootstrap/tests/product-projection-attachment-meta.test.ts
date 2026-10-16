import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  DELIVERY_PROFILES,
  conversationDeltaSchema,
  filterConversationDeltasForProfile,
  type UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

/**
 * 附件页数徽标投影（message-attachments.md「PDF 密码统一通道与阅读进度」）：
 * live 链路 = TurnStarted（无页数）→ TurnAttachmentMetaUpdated 补发；
 * 冷恢复链路 = transcript-hydration 把 pageCount 直接放进 TurnStarted.attachments。
 */
function harness() {
  const projection = new ProductProjection("attachment-meta", "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown, turnId = "turn-1") =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "attachment-meta",
      turnId,
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  const userRow = () =>
    projection.getSnapshot().rows.window.find((r) => r.kind === "userInput") as UserInputRow;
  return { apply, projection, userRow };
}

const PDF_ATTACHMENTS = [
  { fileName: "a.pdf", mime: "application/pdf", bytes: 1024 },
  { fileName: "b.png", mime: "image/png", bytes: 512 },
  { fileName: "c.pdf", mime: "application/pdf", bytes: 2048 },
];

describe("TurnAttachmentMetaUpdated product projection", () => {
  it("patches page counts onto the matching attachment indexes", () => {
    const h = harness();
    h.apply(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "read these",
      messageId: "user-1",
      attachments: PDF_ATTACHMENTS,
    });
    const deltas = h.apply(SessionEventType.TurnAttachmentMetaUpdated, {
      turnId: "turn-1",
      messageId: "user-1",
      updates: [
        { index: 0, pageCount: 12 },
        { index: 2, pageCount: 3 },
      ],
    });
    const attachments = h.userRow().attachments;
    expect(attachments?.[0]?.pageCount).toBe(12);
    expect(attachments?.[1]?.pageCount).toBeUndefined();
    expect(attachments?.[2]?.pageCount).toBe(3);
    expect(deltas.some((delta) => delta.op === "row.upserted")).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
    for (const profile of Object.values(DELIVERY_PROFILES)) {
      expect(filterConversationDeltasForProfile(deltas, profile)).toEqual(deltas);
    }
  });

  it("hydrates page counts carried directly on cold-recovery TurnStarted attachments", () => {
    const h = harness();
    h.apply(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "read these",
      messageId: "user-1",
      attachments: [
        { fileName: "a.pdf", mime: "application/pdf", bytes: 1024, pageCount: 42 },
      ],
    });
    expect(h.userRow().attachments?.[0]?.pageCount).toBe(42);
    // 冷恢复后重放的补发事件必须幂等：页数相同则不再发 delta。
    const deltas = h.apply(SessionEventType.TurnAttachmentMetaUpdated, {
      turnId: "turn-1",
      messageId: "user-1",
      updates: [{ index: 0, pageCount: 42 }],
    });
    expect(deltas).toEqual([]);
  });

  it("is idempotent for repeated live updates", () => {
    const h = harness();
    h.apply(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "read these",
      messageId: "user-1",
      attachments: PDF_ATTACHMENTS,
    });
    const payload = {
      turnId: "turn-1",
      messageId: "user-1",
      updates: [{ index: 0, pageCount: 12 }],
    };
    h.apply(SessionEventType.TurnAttachmentMetaUpdated, payload);
    expect(h.userRow().attachments?.[0]?.pageCount).toBe(12);
    expect(h.apply(SessionEventType.TurnAttachmentMetaUpdated, payload)).toEqual([]);
  });

  it("no-ops when the mapped product turn does not own the row", () => {
    const h = harness();
    h.apply(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "first",
      messageId: "user-1",
      attachments: PDF_ATTACHMENTS,
    });
    // 第二轮登记 turn-2 → user-2 映射；携带 turn-2 的补发事件不能改 user-1 的行。
    h.apply(
      SessionEventType.TurnStarted,
      {
        turnNumber: 2,
        input: "second",
        messageId: "user-2",
      },
      "turn-2",
    );
    const before = h.userRow().attachments;
    const deltas = h.apply(SessionEventType.TurnAttachmentMetaUpdated, {
      turnId: "turn-2",
      messageId: "user-1",
      updates: [{ index: 0, pageCount: 12 }],
    });
    expect(deltas).toEqual([]);
    expect(h.userRow().attachments).toEqual(before);
  });

  it("ignores out-of-range indexes and rows without attachments", () => {
    const h = harness();
    h.apply(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "plain text",
      messageId: "user-1",
    });
    expect(
      h.apply(SessionEventType.TurnAttachmentMetaUpdated, {
        turnId: "turn-1",
        messageId: "user-1",
        updates: [{ index: 0, pageCount: 5 }],
      }),
    ).toEqual([]);
    h.apply(SessionEventType.TurnStarted, {
      turnNumber: 2,
      input: "with attachments",
      messageId: "user-2",
      attachments: PDF_ATTACHMENTS,
    });
    expect(
      h.apply(SessionEventType.TurnAttachmentMetaUpdated, {
        turnId: "turn-2",
        messageId: "user-2",
        updates: [{ index: 9, pageCount: 5 }],
      }),
    ).toEqual([]);
  });
});
