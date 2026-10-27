/**
 * `zcode recognize` 的接地判定（image-recognition-cli.md §5.1「接地不变量」）。
 *
 * ## 为什么需要它（运行时证据，不是推测）
 *
 * `image-recognizer` 的图**不在**模型请求里，只在模型**自己调 `Read`** 时才作为附件到达。
 * 模型可以跳过 `Read` 直接作答——此时它从未见过这张图，却照样能吐出一段像模像样的文字。
 *
 * 实测（律小虾 2026-10-24 22:04 跑批，76 页 / 157 个子代理）：22 个子代理 **0 次工具调用**
 * （从未读图），其中 21 页的正文被当成成功结果收进页卡，编造内容包括一段 Vue.js 文档、
 * 虚构的访谈节目、QQ 群广告、内部心跳日志。同一张图的另一次派发读了图，答案正确。
 *
 * 对法律工作底稿而言，编造的转写比空白危险得多：**没有图像依据的正文不得采纳**。
 */

/** 未接地时的统一措辞：进 failure envelope 的 message，让调用方能如实披露缺口。 */
export const RECOGNIZE_UNGROUNDED_MESSAGE =
  "recognizer answered without reading the image (no Read tool call): the answer has no image basis";

export interface RecognizeGroundingVerdict {
  /** true = 正文有图像依据；false = 没有，正文必须丢弃。 */
  grounded: boolean;
  /** 未接地时的可披露原因（短句）；接地时为空串。 */
  message: string;
}

/**
 * 接地判定：`image-recognizer` profile 只有 `Read` 一个可用工具
 * （`recognize-agent.ts` 的 `tools: ["Read"]`），故「0 次工具调用」= 从未读过这张图。
 *
 * 已知边界（spec §11 第 10 条）：`Read` 之外的工具调用也计入计数，理论上存在
 * 「只调了别的工具」的漏判；实测 `RespondToCoordinator` 全部与 `Read` 同时出现。
 */
export function judgeRecognizeGrounding(input: {
  totalToolUseCount: number;
}): RecognizeGroundingVerdict {
  const count = input.totalToolUseCount;
  if (!Number.isFinite(count) || count <= 0) {
    return { grounded: false, message: RECOGNIZE_UNGROUNDED_MESSAGE };
  }
  return { grounded: true, message: "" };
}
