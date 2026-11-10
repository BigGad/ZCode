import type { FileSystemPort, LocalInfraPort, MineruTier, TraceContext } from "../../deps.js";
import type { ProvisioningRuleId } from "./types.js";

/**
 * 本地 OCR 的供给执行（spec：docs/design/v2/capability-provisioning.md §9.2 的第 ③ 步）。
 *
 * ⚠️ **引擎调用经 `LocalInfraPort`**（不 spawn 子进程）—— 子进程永远在端口后面。
 * ⚠️ **只调一次引擎**：产物断言失败 ⇒ 失败，**不换档重跑**、不静默换路。
 */

/** 供给请求。 */
export interface LocalOcrRequest {
  /** 待解析文件的绝对路径。 */
  readonly absolutePath: string;
  /** 产物输出目录（**必须**是会话级 artifact 目录，不得落在用户源文件旁）。 */
  readonly outputDir: string;
  /** 显式档位；不给则由引擎自选。 */
  readonly tier?: MineruTier;
  readonly localInfraPort: LocalInfraPort;
  readonly fileSystemPort: FileSystemPort;
  readonly traceContext: TraceContext;
  readonly abortSignal?: AbortSignal;
}

export interface LocalOcrSuccess {
  readonly ok: true;
  /** markdown 正文（投影进 prompt 的内容）。 */
  readonly markdown: string;
  /** markdown 的绝对路径。 */
  readonly markdownPath: string;
  /** 产物目录。 */
  readonly outputDir: string;
  /** markdown 的字节数。 */
  readonly bytes: number;
  readonly tier?: MineruTier;
  readonly warnings: readonly string[];
}

export interface LocalOcrFailure {
  readonly ok: false;
  /** 命中的规则：引擎调用失败（spec §7.2 第 9 行）。 */
  readonly ruleId: ProvisioningRuleId;
  /** 人话原因。 */
  readonly message: string;
  /** 可处置提示（引擎 stderr 尾部等）。 */
  readonly hint?: string;
  /** 引擎内部错误码。 */
  readonly engineCode?: string;
}

export type LocalOcrOutcome = LocalOcrSuccess | LocalOcrFailure;

/** 执行本地 OCR：解析 → 读回 markdown。 */
export async function provisionLocalOcr(request: LocalOcrRequest): Promise<LocalOcrOutcome> {
  const result = await request.localInfraPort.parse({
    path: request.absolutePath,
    outputDir: request.outputDir,
    ...(request.tier !== undefined ? { tier: request.tier } : {}),
  });

  if (!result.ok) {
    const engineCode = result.error?.details?.engineCode;
    return {
      ok: false,
      ruleId: "rule-9",
      message: result.error?.message ?? "本地解析引擎执行失败。",
      ...(result.error?.hint !== undefined ? { hint: result.error.hint } : {}),
      ...(typeof engineCode === "string" ? { engineCode } : {}),
    };
  }

  const markdownPath = result.output?.markdownPath;
  if (markdownPath === undefined) {
    return {
      ok: false,
      ruleId: "rule-9",
      message: "本地解析引擎执行成功，但没有产出 markdown 文件。",
      hint: "可手动跑 `zcode ocr parse --path <文件>` 确认产物去了哪里。",
      engineCode: "artifact_missing",
    };
  }

  let markdown: string;
  try {
    const read = await request.fileSystemPort.readTextFile(
      { path: markdownPath, encoding: "utf8", trace: request.traceContext },
      { signal: request.abortSignal },
    );
    markdown = read.content;
  } catch {
    return {
      ok: false,
      ruleId: "rule-9",
      message: `读取本地解析产物失败：${markdownPath}`,
      engineCode: "artifact_missing",
    };
  }

  return {
    ok: true,
    markdown,
    markdownPath,
    outputDir: result.output?.outputDir ?? request.outputDir,
    bytes: Buffer.byteLength(markdown, "utf8"),
    ...(result.tier !== undefined ? { tier: result.tier } : {}),
    warnings: result.warnings,
  };
}
