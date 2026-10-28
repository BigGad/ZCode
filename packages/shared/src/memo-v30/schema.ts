import { z } from "zod";
import {
  V30_DISCLOSURE_REASONS,
  V30_OUTPUT_MODES,
  V30_PAGE_REF_RE,
  V30_PER_ITEM_DISCLOSURE_REASONS,
  V30_TYPES,
} from "./tables.js";

/**
 * v3.0 阅卷笔录 JSON 的**结构合同**（契约文件 `v30-memo.schema.json` 的结构部分）。
 *
 * ⚠️ **结构只是合同的一半** —— 跨字段规则（CF-01~08）在 `cross-fields.ts` 里逐条求值。
 * 只照结构实现会被整卷拒（契约文件自己写明）。
 */

/** 页码引用（`【卷03·第4-11页】` / `【卷03·第4页起】`）。 */
const v30PageRef = z.string().regex(V30_PAGE_REF_RE, "页码引用格式不符（【卷NN·第X(-X)页(起)】）");

const v30CaseSchema = z
  .object({
    name: z.string().min(1),
    case_no: z.string().min(1).optional(),
    volumes: z.number().int().min(0),
  })
  .strict();

const v30VolumeSchema = z
  .object({
    no: z.string().min(1),
    theme: z.string().min(1),
    page_total: z.number().int().min(0),
  })
  .strict();

const v30CatalogItemSchema = z
  .object({
    kind: z.literal("item"),
    seq: z.number().int().positive(),
    title: z.string().min(1),
    page_ref: v30PageRef,
  })
  .strict();

const v30CatalogGroupSchema = z
  .object({
    kind: z.literal("group"),
    label: z.string().min(1),
    page_ref: v30PageRef,
    seqs: z.array(z.number().int().positive()).min(1),
  })
  .strict();

const v30CatalogSchema = z.array(z.union([v30CatalogItemSchema, v30CatalogGroupSchema]));

/**
 * **一条披露**（降级 / 未核验的事实）。
 *
 * ⚠️ `seq` 省略 = **卷级**披露（如「整卷目录不可信」）；带 `seq` = 逐件披露。
 * ⚠️ 逐件才成立的原因（`catalog_title_unverified`）**必须**带 `seq` ——
 * 少了它，宿主无从标出**是哪一件**没核验。
 */
const v30DisclosureSchema = z
  .object({
    seq: z.number().int().positive().optional(),
    reason: z.enum(V30_DISCLOSURE_REASONS),
    note: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.seq === undefined &&
      (V30_PER_ITEM_DISCLOSURE_REASONS as readonly string[]).includes(value.reason)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["seq"],
        message: `披露原因 ${value.reason} 是逐件事实，必须带 seq`,
      });
    }
  });

const v30EvidenceSchema = z
  .object({
    seq: z.number().int().positive(),
    type: z.enum(V30_TYPES),
    output_mode: z.enum(V30_OUTPUT_MODES),
    title: z.string().min(1),
    page_ref: v30PageRef,
    page_numbers: z.array(z.number().int().positive()).min(1),
    meta: z.record(z.string(), z.string().min(1)),
    deleted: z.string().min(1).optional(),
    group: z
      .object({ label: z.string().min(1), page_ref: v30PageRef })
      .strict()
      .optional(),
    body: z.array(z.object({ kind: z.enum(["q", "a", "text"]), text: z.string() }).strict()),
  })
  .strict();

/** **v30 笔录 JSON 的结构合同**（镜像契约文件的结构部分）。 */
export const v30DocumentSchema = z
  .object({
    case: v30CaseSchema,
    volume: v30VolumeSchema,
    catalog: v30CatalogSchema,
    evidence: z.array(v30EvidenceSchema),
    disclosures: z.array(v30DisclosureSchema).optional(),
  })
  .strict();

/** 一份 v30 笔录 JSON。 */
export type V30Document = z.infer<typeof v30DocumentSchema>;

/** 目录里的一条（item 或 group）。 */
export type V30CatalogEntry = V30Document["catalog"][number];

/** 正文里的一条。 */
export type V30Evidence = V30Document["evidence"][number];

/** 一条披露。 */
export type V30Disclosure = NonNullable<V30Document["disclosures"]>[number];
