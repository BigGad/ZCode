/**
 * 能力积木的标准调用示例：业务靠模仿写代码，这里放的就是该模仿的那份。
 *
 * ⚠️ 业务侧**只解析这一份信封**（spec：`docs/design/v2/capability-cli-blocks.md` §5）。
 */
import {
  CapabilityEnvelopeSchema,
  CapabilityProgressEventSchema,
  type CapabilityEnvelope,
  type CapabilityProgressEvent,
} from "./index.js";

/** 业务解析 `zcode ocr parse --json` 的 stdout：整段是**一个** JSON 对象。 */
export function parseBusinessEnvelope(stdout: string): CapabilityEnvelope {
  // ⚠️ 跨进程边界 ⇒ 用运行时 schema 校验，不靠 TypeScript 断言。
  return CapabilityEnvelopeSchema.parse(JSON.parse(stdout)) as CapabilityEnvelope;
}

/** 业务逐行解析 stderr 的进度流（`--json` 时 stderr 里**只有**进度行）。 */
export function parseProgressLine(line: string): CapabilityProgressEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  const parsed = CapabilityProgressEventSchema.safeParse(JSON.parse(trimmed));
  return parsed.success ? (parsed.data as CapabilityProgressEvent) : undefined;
}
