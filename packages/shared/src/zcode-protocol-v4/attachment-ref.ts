import { z } from "zod";
import { attachmentSourceKindSchema } from "../attachment-source.js";

/** 仅承载已提交内容引用与展示元信息；内容本体不进入 command/topic frame。 */
export const attachmentRefSchema = z
  .object({
    ref: z.string(),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number(),
    sourceKind: attachmentSourceKindSchema.optional(),
    messageCount: z.number().int().nonnegative().optional(),
    /** PDF 等分页文档的页数徽标（展示元信息，additive 2026-10-16）。 */
    pageCount: z.number().int().positive().optional(),
    previewRef: z.string().optional(),
  })
  .strict();

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
