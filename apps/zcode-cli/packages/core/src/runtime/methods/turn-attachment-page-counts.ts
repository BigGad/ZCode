import { SessionEventType } from "@zcode/contracts";
import type { MessageId, TraceContext, TurnId } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 附件页数徽标（见 message-attachments.md「PDF 密码统一通道与阅读进度」节）：
 * TurnStarted 先于 resolve 发出，pageCount 只能随后补发。仅当 ≥1 个附件在
 * resolve 时已知页数（内联 ≤20MiB PDF 页图渲染成功）才发射；updates.index
 * 对齐 TurnStarted.attachments 顺序。仅展示元信息，非敏感。
 */
export async function emitTurnAttachmentPageCounts(
  this: AgentRuntimeInternal,
  input: {
    messageId: MessageId;
    resolved: ResolvedTurnAttachment[];
    traceContext: TraceContext;
    turnId?: TurnId;
  },
): Promise<void> {
  const updates = input.resolved
    .map((attachment, index) => {
      const pageCount = attachment.metadata.pdf?.pageCount;
      return typeof pageCount === "number" && Number.isInteger(pageCount) && pageCount > 0
        ? { index, pageCount }
        : undefined;
    })
    .filter((update) => update !== undefined);
  if (updates.length === 0) return;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnAttachmentMetaUpdated,
      {
        ...(input.turnId ? { turnId: input.turnId } : {}),
        messageId: input.messageId,
        updates,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}
