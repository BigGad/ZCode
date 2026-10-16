import { randomUUID } from "node:crypto";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  SessionEventType,
  type ToolCallId,
} from "@zcode/contracts";
import type { PdfDocumentPageCountRequest, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const PDF_PASSWORD_PERMISSION_RULE_ID = "pdf-password-unlock";
export const PDF_PASSWORD_SKIP_OPTION_LABEL = "Skip";
const PDF_PASSWORD_PERMISSION_REASON = "A password-protected PDF needs a password";

/**
 * 密码统一通道的问询 helper（AskUserQuestion 交互通道）：
 * 附件解析与 Read 工具两条链路共用，由 PdfDocumentPort 装饰器调用。
 *
 * 密码防泄漏关键边界（见 message-attachments.md「PDF 密码统一通道与阅读进度」节）：
 * - PermissionRequested 事件 input 为 {}，不含密码；
 * - 结束时手动发最小化 PermissionResolved（仅 toolCallId + decision），
 *   **不得**调用 this.resolvePermission —— 它会把 broker 的 modifiedInput
 *   （含密码）写进 PermissionResolved 事件，密码随之落盘。
 */
export async function requestPdfPasswordViaAskUserQuestion(
  this: AgentRuntimeInternal,
  request: PdfDocumentPageCountRequest,
  traceContext: TraceContext,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  const question = buildPdfPasswordQuestion(request.filePath);
  const toolCallId = `pdf-unlock-${randomUUID()}` as ToolCallId;

  // PermissionRequested 载荷固定 input:{}（emitPermissionRequest 现状），不含密码。
  await this.emitPermissionRequest(toolCallId, ASK_USER_QUESTION_TOOL_NAME, "low");
  const result = await this.permissionBroker.requestPermission(
    {
      requestId: randomUUID(),
      sessionId: this.sessionId,
      ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
      traceId: traceContext.traceId,
      toolCallId,
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      input: {
        questions: [
          {
            question,
            header: "PDF",
            multiSelect: false,
            options: [
              {
                label: PDF_PASSWORD_SKIP_OPTION_LABEL,
                description: "Continue without reading the password-protected PDF.",
              },
            ],
          },
        ],
      },
      mode: this.getMode(),
      ruleId: PDF_PASSWORD_PERMISSION_RULE_ID,
      reason: PDF_PASSWORD_PERMISSION_REASON,
      riskLevel: "low",
      requestedAt: new Date(),
    },
    { signal: abortSignal },
  );

  // 手动最小化 PermissionResolved：绝不把 modifiedInput（可能含密码）写进事件。
  await this.appendEvent(
    this.createEvent(
      SessionEventType.PermissionResolved,
      { toolCallId, decision: "allow" },
      traceContext,
    ),
    traceContext,
  );

  if (result.decision !== "modify") return undefined;
  const answers = readAnswerRecord(result.modifiedInput);
  const answer = answers?.[question];
  // 选项应答（Skip）与空应答都不视为密码；其余按自由文本密码处理。
  if (answer === undefined || answer === PDF_PASSWORD_SKIP_OPTION_LABEL) return undefined;
  const password = answer.trim();
  return password.length > 0 ? password : undefined;
}

export function buildPdfPasswordQuestion(filePath: string): string {
  const filename = filePath.split(/[\\/]/).pop() ?? filePath;
  return `PDF "${filename}" is password-protected. Enter the password to unlock it, or choose Skip to continue without it.`;
}

function readAnswerRecord(
  modifiedInput: unknown,
): Record<string, string> | undefined {
  if (typeof modifiedInput !== "object" || modifiedInput === null) return undefined;
  const answers = (modifiedInput as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return undefined;
  return answers as Record<string, string>;
}
