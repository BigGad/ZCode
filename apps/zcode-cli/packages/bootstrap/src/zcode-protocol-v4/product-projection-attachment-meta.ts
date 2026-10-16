import type { ConversationDelta, ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { TurnAttachmentMetaUpdatedPayload } from "@zcode/contracts";

/**
 * 附件页数徽标（TurnAttachmentMetaUpdated）：按 messageId 找 userInput 行、
 * 按 index patch attachments[i].pageCount。turnId 是 runtime 身份，先经
 * productTurnIdByRuntimeTurnId 换算成 product turnId 再比对；映射缺失（cold/legacy）
 * 时以 messageId 为准。事件重放/重复 patch 幂等：无变化时不再发 delta。
 */
export function projectTurnAttachmentMetaUpdated(
  payload: TurnAttachmentMetaUpdatedPayload,
  deps: {
    rows: readonly ConversationRow[];
    productTurnIdByRuntimeTurnId: ReadonlyMap<string, string>;
  },
): ConversationDelta[] {
  const row = deps.rows.find(
    (candidate): candidate is UserInputRow =>
      candidate.kind === "userInput" && candidate.entityId === String(payload.messageId),
  );
  if (!row?.attachments || row.attachments.length === 0) return [];
  const expectedProductTurnId = payload.turnId
    ? deps.productTurnIdByRuntimeTurnId.get(payload.turnId)
    : undefined;
  if (expectedProductTurnId !== undefined && row.turnId !== expectedProductTurnId) return [];
  const changed = payload.updates.some(({ index, pageCount }) => {
    const attachment = row.attachments?.[index];
    return attachment !== undefined && attachment.pageCount !== pageCount;
  });
  if (!changed) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        attachments: row.attachments.map((attachment, index) => {
          const update = payload.updates.find((candidate) => candidate.index === index);
          return update === undefined || attachment.pageCount === update.pageCount
            ? attachment
            : { ...attachment, pageCount: update.pageCount };
        }),
      },
    },
  ];
}
