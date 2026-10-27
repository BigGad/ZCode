/**
 * `zcode recognize` 的结构化输出契约（image-recognition-cli.md「Structured Output」节）。
 *
 * 不引入 zod（CLI 包无该依赖，且 contracts/adapters 有 v3/v4 混用，加依赖会踩 build 的
 * zod-dedupe 门禁）。这里用纯 JSON Schema 对象做 prompt 嵌入 + 轻量结构校验做后置解析，
 * 达成与「prompt 嵌入 schema + 后置 parse」相同的目标，零新依赖、自包含、可测。
 */

export type RecognizeMode = "description" | "qa" | "structured";

export type RecognizeFieldValue = string | number | boolean | null;

export interface DescriptionResult {
  status: "success";
  description: string;
  observations?: string[];
  confidence?: number;
}

export interface QaAnswer {
  q: string;
  a: string;
}

export interface QaResult {
  status: "success";
  answers: QaAnswer[];
  confidence?: number;
}

export interface StructuredResult {
  status: "success";
  fields: Record<string, RecognizeFieldValue>;
  confidence?: number;
}

export type RecognizeFailureReason =
  | "unreadable"
  | "no_text"
  | "model_refusal"
  | "schema_mismatch"
  | "timeout"
  | "other";

export interface FailureResult {
  status: "error";
  reason: RecognizeFailureReason;
  message: string;
}

export type RecognizeResult = DescriptionResult | QaResult | StructuredResult | FailureResult;

/** 每个 mode 嵌入 prompt 的 JSON Schema（机器可读，模型据此约束输出）。 */
function buildJsonSchema(mode: RecognizeMode, fields: readonly string[]): Record<string, unknown> {
  if (mode === "description") {
    return {
      type: "object",
      required: ["status", "description"],
      properties: {
        status: { const: "success" },
        description: { type: "string" },
        observations: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    };
  }
  if (mode === "qa") {
    return {
      type: "object",
      required: ["status", "answers"],
      properties: {
        status: { const: "success" },
        answers: {
          type: "array",
          items: {
            type: "object",
            required: ["q", "a"],
            properties: { q: { type: "string" }, a: { type: "string" } },
            additionalProperties: false,
          },
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    required: ["status", "fields"],
    properties: {
      status: { const: "success" },
      fields: {
        type: "object",
        required: [...fields],
        additionalProperties: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
        },
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    additionalProperties: false,
  };
}

export interface RecognizeDispatchPrompt {
  prompt: string;
  jsonSchemaText: string;
}

/**
 * 读图指令的强度（spec §5.1「接地不变量」）。
 *
 * - `standard`：第一次派发——把「先读图再作答」写进 prompt。
 * - `strict`：未接地后的**重试**——点名上一轮没读图、并要求读不到就如实报 unreadable。
 */
export type RecognizeReadDirective = "standard" | "strict";

/** 读不到图时的统一失败形状：模型自己回这个形状时会被 `parseRecognizeResult` 透传。 */
const UNREADABLE_REPLY = '{"status":"error","reason":"unreadable","message":"<why the image could not be read>"}';

/**
 * 构造派发给单个 image-recognizer 子代理的 prompt（含图像路径、mode、schema 文本）。
 * schema 以文本嵌入，v1 靠 prompt 约束 + 后置解析，不依赖 response_format。
 */
export function buildRecognizeDispatchPrompt(input: {
  imagePath: string;
  mode: RecognizeMode;
  fields?: readonly string[];
  questions?: readonly string[];
  readDirective?: RecognizeReadDirective;
}): RecognizeDispatchPrompt {
  const { imagePath, mode } = input;
  const fields = input.fields ?? [];
  const questions = input.questions ?? [];
  const jsonSchemaText = JSON.stringify(buildJsonSchema(mode, fields));

  let taskText: string;
  if (mode === "description") {
    taskText = "Describe the image: a primary `description`, optional `observations` bullets, optional `confidence`.";
  } else if (mode === "qa") {
    taskText = `Answer every question below as a list of { "q": "…", "a": "…" }.\nQuestions:\n${questions
      .map((q, index) => `${index + 1}. ${q}`)
      .join("\n")}`;
  } else {
    taskText = `Extract these named fields as a flat object (every field must be present):\n${fields
      .map((f) => `- ${f}`)
      .join("\n")}`;
  }

  const prompt = [
    `image: ${imagePath}`,
    `mode: ${mode}`,
    `jsonSchema: ${jsonSchemaText}`,
    "",
    taskText,
    "",
    ...buildReadDirectiveLines(input.readDirective ?? "standard", imagePath),
    "Reply with the JSON object only, conforming to jsonSchema. No markdown fences.",
  ].join("\n");

  return { prompt, jsonSchemaText };
}

/**
 * 读图指令正文。
 *
 * 为什么必须显式写进 prompt（spec §5.1，运行时证据见 `recognize-grounding.ts`）：
 * 图**不在**模型请求里，只在模型自己调 `Read` 时才到达。模型可以跳过 `Read` 直接作答，
 * 于是吐出一段从未见过这张图的「像模像样」文字（实测有 Vue.js 文档、虚构访谈节目）。
 * 指令只能提高读图率，**不能**替代接地判定——判定在 `recognize-runtime.ts` 里 fail-closed。
 */
function buildReadDirectiveLines(
  directive: RecognizeReadDirective,
  imagePath: string,
): readonly string[] {
  if (directive === "strict") {
    return [
      "IMPORTANT: your previous attempt answered WITHOUT reading the image, so that answer had no image basis and was discarded.",
      `You MUST first call the Read tool with exactly this file_path: ${imagePath}`,
      "Only then answer, and only from the image content you actually loaded.",
      `If the image still cannot be read, reply exactly with ${UNREADABLE_REPLY} instead of guessing.`,
    ];
  }
  return [
    "Read the image first: call the Read tool with the file_path above, then answer from what the image shows.",
    "Do not answer from prior knowledge and do not invent content; if the image cannot be read, reply with the error object instead.",
  ];
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

/**
 * 把子代理返回文本解析成 `RecognizeResult`。解析失败归类为 `schema_mismatch`（保留
 * 原始失败原因到 reason 之外，不吞掉用户可操作的信息）。text 为空归 `no_text`。
 */
export function parseRecognizeResult(input: {
  rawText: string;
  mode: RecognizeMode;
  fields?: readonly string[];
  questions?: readonly string[];
}): RecognizeResult {
  const { rawText, mode } = input;
  const fields = input.fields ?? [];
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { status: "error", reason: "no_text", message: "subagent returned empty text" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(trimmed));
  } catch {
    return { status: "error", reason: "schema_mismatch", message: "output is not valid JSON" };
  }

  if (!isRecord(parsed)) {
    return { status: "error", reason: "schema_mismatch", message: "output is not a JSON object" };
  }

  // 子代理已按 prompt 约定在失败时返回 error 形状，直接透传。
  if (parsed.status === "error") {
    return {
      status: "error",
      reason: isFailureReason(parsed.reason) ? parsed.reason : "other",
      message: typeof parsed.message === "string" ? parsed.message : String(parsed.message ?? ""),
    };
  }

  if (parsed.status !== "success") {
    return { status: "error", reason: "schema_mismatch", message: "missing success/error status" };
  }

  if (mode === "description") {
    if (typeof parsed.description !== "string" || parsed.description.trim().length === 0) {
      return { status: "error", reason: "schema_mismatch", message: "description missing" };
    }
    return {
      status: "success",
      description: parsed.description,
      ...(Array.isArray(parsed.observations) && parsed.observations.every((o) => typeof o === "string")
        ? { observations: parsed.observations as string[] }
        : {}),
      ...(isConfidence(parsed.confidence) ? { confidence: parsed.confidence } : {}),
    };
  }

  if (mode === "qa") {
    const answers = parsed.answers;
    if (!Array.isArray(answers) || answers.length === 0) {
      return { status: "error", reason: "schema_mismatch", message: "answers missing or empty" };
    }
    const normalized: QaAnswer[] = [];
    for (const item of answers) {
      if (isRecord(item) && typeof item.q === "string" && typeof item.a === "string") {
        normalized.push({ q: item.q, a: item.a });
      }
    }
    if (normalized.length === 0) {
      return { status: "error", reason: "schema_mismatch", message: "no valid answers" };
    }
    return {
      status: "success",
      answers: normalized,
      ...(isConfidence(parsed.confidence) ? { confidence: parsed.confidence } : {}),
    };
  }

  // structured
  const parsedFields = parsed.fields;
  if (!isRecord(parsedFields)) {
    return { status: "error", reason: "schema_mismatch", message: "fields missing" };
  }
  const values: Record<string, RecognizeFieldValue> = {};
  for (const field of fields) {
    const value = parsedFields[field];
    if (!isFieldValue(value)) {
      return { status: "error", reason: "schema_mismatch", message: `field "${field}" missing or invalid` };
    }
    values[field] = value;
  }
  return {
    status: "success",
    fields: values,
    ...(isConfidence(parsed.confidence) ? { confidence: parsed.confidence } : {}),
  };
}

const FAILURE_REASONS = new Set<RecognizeFailureReason>([
  "unreadable",
  "no_text",
  "model_refusal",
  "schema_mismatch",
  "timeout",
  "other",
]);

function isFailureReason(value: unknown): value is RecognizeFailureReason {
  return typeof value === "string" && FAILURE_REASONS.has(value as RecognizeFailureReason);
}

function isFieldValue(value: unknown): value is RecognizeFieldValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从可能带代码围栏/前后空白的文本中摘出第一个 JSON 对象。 */
function extractJsonObject(text: string): string {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return text;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(firstBrace, index + 1);
    }
  }
  return text;
}