import { z } from "zod";

/**
 * 分析判定输出解析：模型被约束输出单一 JSON 对象，这里用 zod strict 校验。
 *
 * 拒收幻觉输出（非法 JSON / 缺字段）→ 调用方记 `analysis_failed` 事件且不阻塞循环
 * （stream-input.md Continuous watch mode 失败恢复节）。prompt 侧约束见
 * buildAnalysisPrompt（schema 描述附加在文末，与 PDF 页 trailer 文本同法）。
 */

export const STREAM_ANALYSIS_SCHEMA = z.strictObject({
  status: z.enum(["normal", "anomaly"]),
  severity: z.enum(["info", "low", "medium", "high"]).optional(),
  reason: z.string().min(1).max(500),
});

export type StreamAnalysisVerdict = z.infer<typeof STREAM_ANALYSIS_SCHEMA>;

const JSON_OBJECT_EXTRACTION_PATTERN = /\{[\s\S]*\}/u;

export type StreamJudgement =
  | { ok: true; verdict: StreamAnalysisVerdict }
  | { ok: false; failureReason: string };

export function parseStreamAnalysisResponse(response: string): StreamJudgement {
  const trimmed = response.trim();
  const candidate = extractJsonObject(trimmed) ?? trimmed;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    return { ok: false, failureReason: "analysis response is not valid JSON" };
  }
  const result = STREAM_ANALYSIS_SCHEMA.safeParse(parsedJson);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return { ok: false, failureReason: `analysis response schema mismatch: ${detail}` };
  }
  return { ok: true, verdict: result.data };
}

/** 宽松提取首个平衡 JSON 对象；失败返回 undefined（外层直接按全文解析）。 */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  const match = JSON_OBJECT_EXTRACTION_PATTERN.exec(text.slice(start));
  return match?.[0];
}

export interface BuildAnalysisPromptInput {
  streamId: string;
  streamTitle?: string;
  segmentSeq: number;
  /** 受控配置的 analysisPrompt（业务判定目标）。 */
  customPrompt?: string;
}

/**
 * 构造分析 turn 文本。安全红线：只含 stream id / title 与判定指令，
 * 不含 RTSP URL / 凭据（stream-input.md 凭据管理节）。
 */
export function buildAnalysisPrompt(input: BuildAnalysisPromptInput): string {
  const target = input.customPrompt ?? "判断画面中是否出现异常情况（人员入侵、异常移动、遮挡或画面丢失）";
  return [
    `你是视频监控片段分析助手。以下 attached 图片来自网络摄像头「${input.streamTitle ?? input.streamId}」第 ${input.segmentSeq} 号片段，按时间顺序排列。`,
    `分析目标：${target}`,
    "",
    "只输出一个 JSON 对象，不要输出任何其他文本，格式为：",
    '{"status":"normal|anomaly","severity":"info|low|medium|high","reason":"<不超过 200 字的中文判定依据>"}',
    "- status=anomaly 时 severity 必填；normal 时可省略 severity。",
    "- 无法判断（画面全黑、无帧）时 status=normal，reason 说明原因。",
  ].join("\n");
}
