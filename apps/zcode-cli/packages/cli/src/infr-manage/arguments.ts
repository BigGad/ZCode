/**
 * `zcode-infr-manage` 的**自有参数解析入口**。
 *
 * ⚠️ **不能复用 `zcode` 的 `parseGlobalArgs`**（`packages/cli/src/arguments.ts`）：
 * ① 它是 `strict: true`，多一个旗标就整体报错；② **`-p` 已经被 `--prompt` 占用**。
 * ③ 更根本的是：那个旗标表属于 `zcode` 这个 bin，把本地基础设施的旗标塞进去会污染 `zcode` 的选项语义。
 *
 * 旗标一律用长名（spec §7.3 M14）：`--path` / `--output` / `--tier` / `--json`。
 */

/** 需要取值的旗标。 */
const VALUE_FLAGS = new Set(["path", "output", "tier", "source"]);

export type InfrManageCommand =
  | { readonly kind: "doctor"; readonly json: boolean }
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
    }
  | {
      readonly kind: "models-download";
      readonly json: boolean;
      readonly tier: string;
      readonly source?: string;
    }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export function parseInfrManageArgs(argv: readonly string[]): InfrManageCommand {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
      if (!VALUE_FLAGS.has(name)) {
        return { kind: "error", message: `未知旗标：${argument}` };
      }
      let value: string | undefined;
      if (equals >= 0) {
        value = argument.slice(equals + 1);
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          return { kind: "error", message: `旗标 ${argument} 缺少取值` };
        }
        value = next;
        index += 1;
      }
      if (flags.has(name)) {
        return { kind: "error", message: `旗标 ${argument} 重复出现` };
      }
      flags.set(name, value);
      continue;
    }
    if (argument.startsWith("-") && argument.length > 1) {
      return { kind: "error", message: `未知旗标：${argument}` };
    }
    positionals.push(argument);
  }

  if (help) return { kind: "help" };

  const command = positionals[0];
  if (command === undefined) {
    return { kind: "error", message: "缺少命令" };
  }

  if (command === "doctor") {
    const extra = positionals[1];
    if (extra !== undefined) {
      return { kind: "error", message: `doctor 不接受位置参数：${extra}` };
    }
    const unexpected = [...flags.keys()];
    if (unexpected.length > 0) {
      return {
        kind: "error",
        message: `doctor 不接受旗标：${unexpected.map((n) => `--${n}`).join("、")}`,
      };
    }
    return { kind: "doctor", json };
  }

  if (command === "parse") {
    const extra = positionals[1];
    if (extra !== undefined) {
      return { kind: "error", message: `parse 只接受 --path 指定输入，不接受位置参数：${extra}` };
    }
    const path = flags.get("path");
    if (path === undefined || path.trim() === "") {
      return { kind: "error", message: "parse 需要 --path <file>" };
    }
    const output = flags.get("output");
    const tier = flags.get("tier");
    return {
      kind: "parse",
      json,
      path,
      ...(output !== undefined ? { output } : {}),
      ...(tier !== undefined ? { tier } : {}),
    };
  }

  if (command === "models") {
    const subcommand = positionals[1];
    if (subcommand !== "download") {
      return {
        kind: "error",
        message:
          subcommand === undefined
            ? "models 需要子命令（download）"
            : `未知 models 子命令：${subcommand}`,
      };
    }
    const extra = positionals[2];
    if (extra !== undefined) {
      return { kind: "error", message: `models download 不接受位置参数：${extra}` };
    }
    const tier = flags.get("tier");
    if (tier === undefined || tier.trim() === "") {
      return { kind: "error", message: "models download 需要 --tier <basic|standard>" };
    }
    const source = flags.get("source");
    return {
      kind: "models-download",
      json,
      tier,
      ...(source !== undefined ? { source } : {}),
    };
  }

  return { kind: "error", message: `未知命令：${command}` };
}
