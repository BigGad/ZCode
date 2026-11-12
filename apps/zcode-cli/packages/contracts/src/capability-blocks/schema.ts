// ============================================================
// 能力积木的运行时 schema —— 跨进程边界必须能校验
// ============================================================

import { z } from "zod";

import {
  CAPABILITY_BLOCK_IDS,
  CAPABILITY_ERROR_CODES,
  CAPABILITY_PROGRESS_PHASES,
} from "./contract.js";

/**
 * ⚠️ 这些 schema 的用途是**校验跨进程边界的载荷**（业务解析 `zcode ocr` 的 stdout、
 * 业务逐行解析 stderr 的进度流），不是替代 TypeScript 类型。
 *
 * ⚠️ zod v3 的 `z.enum` 接受 readonly 元组 —— 闭集常量直接传进来，取值不会漂。
 */
export const CapabilityBlockIdSchema = z.enum(CAPABILITY_BLOCK_IDS);

export const CapabilityErrorCodeSchema = z.enum(CAPABILITY_ERROR_CODES);

export const CapabilityProgressPhaseSchema = z.enum(CAPABILITY_PROGRESS_PHASES);

export const CapabilityEnvelopeErrorSchema = z.object({
  code: CapabilityErrorCodeSchema,
  message: z.string(),
  hint: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

/**
 * 度量段允许**额外字段**（`catchall`）—— 积木可以加自己的度量，但不能删掉已承诺的字段。
 */
export const CapabilityEnvelopeMetricsSchema = z
  .object({
    durationMs: z.number().optional(),
    warnings: z.array(z.string()).optional(),
    degradedFrom: z.string().optional(),
  })
  .catchall(z.unknown());

export const CapabilitySuccessEnvelopeSchema = z.object({
  version: z.number().int(),
  key: CapabilityBlockIdSchema,
  ok: z.literal(true),
  output: z.record(z.unknown()),
  metrics: CapabilityEnvelopeMetricsSchema.optional(),
});

export const CapabilityFailureEnvelopeSchema = z.object({
  version: z.number().int(),
  key: CapabilityBlockIdSchema,
  ok: z.literal(false),
  error: CapabilityEnvelopeErrorSchema,
  metrics: CapabilityEnvelopeMetricsSchema.optional(),
});

/** 完整信封。`ok` 是判别子 ⇒ 成功必带 `output`，失败必带 `error`。 */
export const CapabilityEnvelopeSchema = z.discriminatedUnion("ok", [
  CapabilitySuccessEnvelopeSchema,
  CapabilityFailureEnvelopeSchema,
]);

/** 进度事件（stderr 的一行）。 */
export const CapabilityProgressEventSchema = z.object({
  type: z.literal("progress"),
  phase: CapabilityProgressPhaseSchema,
  message: z.string(),
  percent: z.number().nullable(),
});
