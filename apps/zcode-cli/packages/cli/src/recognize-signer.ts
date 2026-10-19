import { createHash } from "node:crypto";
import { basename } from "node:path";
import { createSessionId, type SessionId } from "@zcode/contracts";

/**
 * `zcode recognize` 的标识合成（image-recognition-cli.md「Concurrency」节）。
 *
 * CLI 派发的子代理并非真实 tool call，但 `SubagentRunRequest.parentToolCallId` 必填
 * （subagent.port.ts:14）。这里按 traceId 合成确定且唯一的 id，保持 trace 可关联，
 * 不伪造 tool-call 基础设施。
 *
 * `runtimeSessionId` 是派发请求里填的期望会话 id，runner 用它派生 trace 父子关系与子代理
 * 输出目录；子 runtime 的事实会话 id 由 runner 在 `createSubagentLifecycle` 里另铸为
 * `sess_subagent_<agentId>`（无视 `request.sessionId`）。进度归并因此走两个不同的键：
 * 父子事件认 `parentToolCallId`，子会话流式事件认 `SubagentSpawned` 载荷里的 `childSessionId`。
 */

export interface RecognizeSigner {
  /** `recognize-${traceIdShort}-${index}` —— 满足 parentToolCallId 必填约束。 */
  parentToolCallId(index: number): string;
  /** `sess_recognize_${traceIdShort}_${index}` —— 子 runtime 的会话 id，批次内唯一。 */
  runtimeSessionId(index: number): SessionId;
  /** `image-${index + 1}` —— 给进度行用的稳定短标签。 */
  agentLabel(index: number): string;
  /** `a3f` —— 进度行上的 trace 关联句柄，同一批次内每个 index 不同。 */
  shortId(index: number): string;
}

export function createRecognizeSigner(traceId: string): RecognizeSigner {
  const traceIdShort = createHash("sha256").update(traceId).digest("hex").slice(0, 8);

  const runtimeSessionId = (index: number): SessionId =>
    createSessionId(`recognize_${traceIdShort}_${index}`);

  return {
    parentToolCallId: (index) => `recognize-${traceIdShort}-${index}`,
    runtimeSessionId,
    agentLabel: (index) => `image-${index + 1}`,
    // 从子会话 id 再摘 3 位：与 runtimeSessionId 同源，不引入第二套编号规则。
    shortId: (index) => createHash("sha256").update(runtimeSessionId(index)).digest("hex").slice(0, 3),
  };
}

/** 取绝对路径的 basename，供 plan/result 展示用。 */
export function imageBasename(fullPath: string): string {
  return basename(fullPath);
}
