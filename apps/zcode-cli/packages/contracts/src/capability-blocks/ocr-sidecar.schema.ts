// ============================================================
// 产物 sidecar v3 的运行时 schema
// ============================================================

import { z } from "zod";

import {
  OCR_ELEMENT_CATEGORIES,
  OCR_ELEMENT_ORIGINS,
  OCR_PAGE_COMPOSITIONS,
  OCR_PAGE_STATUSES,
  OCR_SIDECAR_VERSION,
} from "./contract.js";

export const OcrElementCategorySchema = z.enum(OCR_ELEMENT_CATEGORIES);

export const OcrPageCompositionSchema = z.enum(OCR_PAGE_COMPOSITIONS);

export const OcrPageStatusSchema = z.enum(OCR_PAGE_STATUSES);

export const OcrElementOriginSchema = z.enum(OCR_ELEMENT_ORIGINS);

/**
 * 元素 schema。
 *
 * ⚠️ **`type` 是开放字符串**，且引擎可能在元素上带额外字段 ⇒ `catchall` 放行。
 */
export const OcrSidecarElementSchema = z
  .object({
    category: OcrElementCategorySchema,
    type: z.string(),
    origin: OcrElementOriginSchema.optional(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    text: z.string().optional(),
    imagePath: z.string().optional(),
  })
  .catchall(z.unknown());

export const OcrSidecarPageSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  widthPt: z.number(),
  heightPt: z.number(),
  status: OcrPageStatusSchema,
  composition: OcrPageCompositionSchema.nullable(),
  otherElements: z.number().int().nonnegative(),
  elements: z.array(OcrSidecarElementSchema),
});

export const OcrSidecarSourceSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  mtimeMs: z.number(),
});

export const OcrSidecarEngineSchema = z
  .object({
    name: z.string(),
    variant: z.string(),
    version: z.string(),
    tier: z.string(),
    route: z.string(),
    assets: z.record(z.unknown()),
  })
  .catchall(z.unknown());

/**
 * 统一 sidecar v3。
 *
 * ⚠️ **版本号不复用**：v1 / v2 是两个已废止的历史变体，只有 `3` 是当前格式。
 */
export const OcrSidecarSchema = z
  .object({
    version: z.literal(OCR_SIDECAR_VERSION),
    source: OcrSidecarSourceSchema,
    engine: OcrSidecarEngineSchema,
    artifactsDir: z.string(),
    pages: z.array(OcrSidecarPageSchema),
    text: z.object({ markdownPath: z.string() }).optional(),
  })
  .catchall(z.unknown());
