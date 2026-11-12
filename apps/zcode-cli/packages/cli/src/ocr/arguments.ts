/**
 * `zcode ocr` 的**组合校验层**。
 *
 * ⚠️ **旗标的存在性由全局解析器负责**：`zcode` 的 `parseGlobalArgs` 是
 * `strict: true`，子命令的旗标必须在全局旗标表注册（`packages/cli/src/arguments.ts`），
 * 否则 `zcode ocr parse --path x.pdf` 在进分派表之前就报"未知参数"。
 * ⇒ 本层**只校验"哪个子命令收哪些旗标"的组合**，不重复校验旗标名。
 *
 * ⚠️ **旗标一律用长名**（spec §7.3 M14）：`-p` 已被 `--prompt` 占用。
 */

/** `zcode ocr` 的私有旗标（与全局旗标表一一对应）。 */
export interface OcrFlags {
  readonly path?: string;
  readonly output?: string;
  readonly tier?: string;
  readonly source?: string;
  /** `--force`：忽略 sidecar 缓存，强制重算（spec §6.5 的接力断点）。 */
  readonly force?: boolean;
  /** `--pdf-password`：加密 PDF 的密码（**只经 argv 传递，不落盘、不入日志**）。 */
  readonly pdfPassword?: string;
}

/** 组合校验的输入。 */
export interface OcrCommandInput {
  /** `zcode ocr` **之后**的位置参数（子命令 + 子命令的位置参数）。 */
  readonly positionals: readonly string[];
  /** 全局解析器给出的旗标取值。 */
  readonly flags: OcrFlags;
  /** `--json`（全局旗标）。 */
  readonly json: boolean;
  /** `--help`（全局旗标）。 */
  readonly help: boolean;
}

export type OcrCommand =
  | { readonly kind: "doctor"; readonly json: boolean }
  | {
      readonly kind: "inspect";
      readonly json: boolean;
      readonly path: string;
      readonly output?: string;
      /** `--force`：忽略 sidecar 缓存，强制重算。 */
      readonly force?: boolean;
      /** `--pdf-password`：加密 PDF 的密码（argv only）。 */
      readonly pdfPassword?: string;
    }
  | {
      readonly kind: "parse";
      readonly json: boolean;
      readonly path: string;
      readonly output?: string;
      /**
       * 档位原样透传，**不在这里校验**。
       * ⚠️ 档位合法性由端口判定（内部码 `engine_not_found`），CLI 预校验会让
       * 验收 A4 要求的错误形状（`error.code = "invalid_input"` + `details.engineCode`）出不来。
       */
      readonly tier?: string;
      /** `--force`：忽略 sidecar 缓存，强制重算。 */
      readonly force?: boolean;
      /** `--pdf-password`：加密 PDF 的密码（argv only）。 */
      readonly pdfPassword?: string;
    }
  | {
      readonly kind: "models-download";
      readonly json: boolean;
      readonly tier: string;
      readonly source?: string;
    }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export function parseOcrArgs(input: OcrCommandInput): OcrCommand {
  const { flags } = input;
  if (input.help) return { kind: "help" };

  const command = input.positionals[0];
  if (command === undefined) {
    return { kind: "error", message: "缺少命令" };
  }

  if (command === "doctor") {
    const extra = input.positionals[1];
    if (extra !== undefined) {
      return { kind: "error", message: `doctor 不接受位置参数：${extra}` };
    }
    const unexpected = unexpectedFlags(flags, []);
    if (unexpected.length > 0) {
      return { kind: "error", message: `doctor 不接受旗标：${unexpected.join("、")}` };
    }
    return { kind: "doctor", json: input.json };
  }

  if (command === "inspect") {
    const extra = input.positionals[1];
    if (extra !== undefined) {
      return { kind: "error", message: `inspect 只接受 --path 指定输入，不接受位置参数：${extra}` };
    }
    // ⚠️ **`inspect` 没有 `--tier`**（spec §4.2）：它只出页成分 + 元素位置，
    // 档位是识别路线的概念，原生分析路线压根不烧权重。
    const unexpected = unexpectedFlags(flags, ["path", "output", "force", "pdf-password"]);
    if (unexpected.length > 0) {
      return { kind: "error", message: `inspect 不接受旗标：${unexpected.join("、")}` };
    }
    const path = flags.path;
    if (path === undefined || path.trim() === "") {
      return { kind: "error", message: "inspect 需要 --path <file>" };
    }
    return {
      kind: "inspect",
      json: input.json,
      path,
      ...(flags.output !== undefined ? { output: flags.output } : {}),
      ...(flags.force === true ? { force: true } : {}),
      ...(flags.pdfPassword !== undefined ? { pdfPassword: flags.pdfPassword } : {}),
    };
  }

  if (command === "parse") {
    const extra = input.positionals[1];
    if (extra !== undefined) {
      return { kind: "error", message: `parse 只接受 --path 指定输入，不接受位置参数：${extra}` };
    }
    const unexpected = unexpectedFlags(flags, ["path", "output", "tier", "force", "pdf-password"]);
    if (unexpected.length > 0) {
      return { kind: "error", message: `parse 不接受旗标：${unexpected.join("、")}` };
    }
    const path = flags.path;
    if (path === undefined || path.trim() === "") {
      return { kind: "error", message: "parse 需要 --path <file>" };
    }
    return {
      kind: "parse",
      json: input.json,
      path,
      ...(flags.output !== undefined ? { output: flags.output } : {}),
      ...(flags.tier !== undefined ? { tier: flags.tier } : {}),
      ...(flags.force === true ? { force: true } : {}),
      ...(flags.pdfPassword !== undefined ? { pdfPassword: flags.pdfPassword } : {}),
    };
  }

  if (command === "models") {
    const subcommand = input.positionals[1];
    if (subcommand !== "download") {
      return {
        kind: "error",
        message:
          subcommand === undefined
            ? "models 需要子命令（download）"
            : `未知 models 子命令：${subcommand}`,
      };
    }
    const extra = input.positionals[2];
    if (extra !== undefined) {
      return { kind: "error", message: `models download 不接受位置参数：${extra}` };
    }
    const unexpected = unexpectedFlags(flags, ["tier", "source"]);
    if (unexpected.length > 0) {
      return { kind: "error", message: `models download 不接受旗标：${unexpected.join("、")}` };
    }
    const tier = flags.tier;
    if (tier === undefined || tier.trim() === "") {
      return { kind: "error", message: "models download 需要 --tier <basic|standard>" };
    }
    return {
      kind: "models-download",
      json: input.json,
      tier,
      ...(flags.source !== undefined ? { source: flags.source } : {}),
    };
  }

  return { kind: "error", message: `未知命令：${command}` };
}

/** 列出不在允许集合里的旗标（按固定顺序输出，便于测试断言）。 */
function unexpectedFlags(flags: OcrFlags, allowed: readonly string[]): string[] {
  const present: Array<[string, string | boolean | undefined]> = [
    ["path", flags.path],
    ["output", flags.output],
    ["tier", flags.tier],
    ["source", flags.source],
    ["force", flags.force],
    ["pdf-password", flags.pdfPassword],
  ];
  return present
    .filter(([name, value]) => value !== undefined && !allowed.includes(name))
    .map(([name]) => `--${name}`);
}
