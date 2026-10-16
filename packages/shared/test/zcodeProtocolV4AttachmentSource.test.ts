import { describe, expect, it } from "vitest";
import {
  userInputRowSchema,
  v4AttachmentReadResultSchema,
  PROTOCOL_V4_LIMITS,
} from "../src/zcode-protocol-v4/index.js";

describe("V4 attachment source across row transport", () => {
  it("accepts text preview responses and keeps the text attachment size limit", () => {
    const response = {
      dataBase64: "aGk=",
      mediaType: "text/plain; charset=utf-8",
      totalBytes: 2,
      nextOffset: null,
    };
    expect(v4AttachmentReadResultSchema.parse(response)).toEqual(response);
    expect(() =>
      v4AttachmentReadResultSchema.parse({
        ...response,
        totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
      }),
    ).toThrow();
    expect(() =>
      v4AttachmentReadResultSchema.parse({ ...response, mediaType: "text/html" }),
    ).toThrow();
  });
  it.each(["clipboard-text", "topic-history"])(
    "preserves %s on the executed user row",
    (sourceKind) => {
      const attachment = {
        ref: "zcode-artifact://history",
        fileName: "history.txt",
        mime: "text/plain",
        bytes: 84,
        sourceKind,
        messageCount: 1,
      };
      const row = userInputRowSchema.parse({
        rowId: 1,
        turnId: "turn-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "userInput",
        origin: "realUser",
        text: "request",
        attachments: [attachment],
      });
      expect(row.attachments).toEqual([attachment]);
    },
  );
  it("preserves the optional PDF pageCount badge on the user row", () => {
    const attachment = {
      ref: "/doc/volume.pdf",
      fileName: "volume.pdf",
      mime: "application/pdf",
      bytes: 1024,
      pageCount: 42,
    };
    const row = userInputRowSchema.parse({
      rowId: 2,
      turnId: "turn-2",
      createdAt: 2,
      createdAtSeq: 2,
      kind: "userInput",
      origin: "realUser",
      text: "阅卷",
      attachments: [attachment],
    });
    expect(row.attachments).toEqual([attachment]);
    // 无页数的旧附件必须原样通过（additive 向后兼容）；页数必须为正整数。
    expect(
      userInputRowSchema.parse({
        rowId: 3,
        turnId: "turn-3",
        createdAt: 3,
        createdAtSeq: 3,
        kind: "userInput",
        origin: "realUser",
        text: "legacy",
        attachments: [{ ref: "/a.pdf", fileName: "a.pdf", mime: "application/pdf", bytes: 1 }],
      }).attachments,
    ).toEqual([{ ref: "/a.pdf", fileName: "a.pdf", mime: "application/pdf", bytes: 1 }]);
    expect(() =>
      userInputRowSchema.parse({
        rowId: 4,
        turnId: "turn-4",
        createdAt: 4,
        createdAtSeq: 4,
        kind: "userInput",
        origin: "realUser",
        text: "invalid",
        attachments: [
          { ref: "/b.pdf", fileName: "b.pdf", mime: "application/pdf", bytes: 1, pageCount: 0 },
        ],
      }),
    ).toThrow();
  });
});
