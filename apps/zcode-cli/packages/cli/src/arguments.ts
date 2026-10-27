import { parseArgs } from "node:util";

export const parseGlobalArgs = (argv: string[]) =>
  parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      json: {
        type: "boolean",
      },
      "output-format": {
        type: "string",
      },
      "no-color": {
        type: "boolean",
      },
      "no-browser": {
        type: "boolean",
      },
      "browser-use": {
        type: "string",
      },
      "browser-executable": {
        type: "string",
      },
      prompt: {
        short: "p",
        type: "string",
      },
      "memory-bench": {
        type: "boolean",
      },
      attach: {
        multiple: true,
        type: "string",
      },
      // `--pdf-password`：无头（--prompt/--target）下密码 PDF 的非交互密码来源；
      // 严格解析器要求全局注册，作用域校验在 run.ts。
      "pdf-password": {
        type: "string",
      },
      // `--model-type <名字>`：按命名模型类型点名本次运行的主模型（model-selections.md §6）。
      // 与 `zcode recognize` 自己的 `--model <providerId>/<modelId>` 取值格式不同、职责不同，
      // 两个旗标并存不冲突。
      "model-type": {
        type: "string",
      },
      // `--capability <能力键>=<类型名>`：本次运行里某个能力由哪个命名类型承担
      // （model-selections.md §6.3）。可重复传入。
      capability: {
        multiple: true,
        type: "string",
      },
      cwd: {
        type: "string",
      },
      locale: {
        type: "string",
      },
      resume: {
        type: "string",
      },
      target: {
        type: "string",
      },
      "target-replace": {
        type: "boolean",
      },
      continue: {
        short: "c",
        type: "boolean",
      },
      force: {
        short: "f",
        type: "boolean",
      },
      "force-mcs": {
        type: "boolean",
      },
      mode: {
        type: "string",
      },
      verbose: {
        type: "boolean",
      },
      version: {
        short: "v",
        type: "boolean",
      },
      "prepare-storage": { type: "boolean" },
      stdio: {
        type: "boolean",
      },
      surface: {
        type: "string",
      },
      "workflow-mode": {
        type: "string",
      },
      // `zcode plugins` 子命令旗标：strict 解析器要求
      // 在全局注册，run.ts 收集后透传给 plugins-command，不污染其他命令的选项语义。
      all: {
        short: "a",
        type: "boolean",
      },
      available: {
        type: "boolean",
      },
      "keep-data": {
        type: "boolean",
      },
      scope: {
        short: "s",
        type: "string",
      },
      sparse: {
        multiple: true,
        type: "string",
      },
      // `zcode usage` 子命令旗标：明细导出的窗口/过滤（严格解析器要求全局注册）。
      since: {
        type: "string",
      },
      until: {
        type: "string",
      },
      session: {
        type: "string",
      },
      sessions: {
        type: "boolean",
      },
      agent: {
        type: "string",
      },
      limit: {
        type: "string",
      },
      tools: {
        type: "boolean",
      },
      // `zcode stream` 子命令旗标：RTSP 持续监控（严格解析器要求全局注册）。
      stream: {
        type: "string",
      },
      once: {
        type: "boolean",
      },
      follow: {
        type: "boolean",
      },
      status: {
        type: "string",
      },
      config: {
        type: "string",
      },
      // stream watch 运行时长与后台常驻（stream-input.md「运行时长与后台常驻」节）。
      duration: {
        type: "string",
      },
      forever: {
        type: "boolean",
      },
      // 内部旗标：--forever 后台子进程标记，不写入帮助文案。
      daemon: {
        type: "boolean",
      },
      // `zcode providers init` 子命令旗标：生成具名模型类型（严格解析器要求全局注册）。
      "dry-run": {
        type: "boolean",
      },
      // `zcode recognize` 子命令旗标：图片文件夹批量多模态识别（严格解析器要求全局注册，
      // 作用域校验在 recognize-command.ts 的 resolveScope）。
      model: {
        type: "string",
      },
      schema: {
        type: "string",
      },
      fields: {
        multiple: true,
        type: "string",
      },
      questions: {
        multiple: true,
        type: "string",
      },
      "max-concurrency": {
        type: "string",
      },
      recursive: {
        type: "boolean",
      },
      "image-glob": {
        type: "string",
      },
    },
    strict: true,
  });

/** 入口与命令路由复用同一参数定义，不能把 prompt/cwd 的值误当成协议命令。 */
export function isProtocolServerInvocation(argv: string[]): boolean {
  try {
    const parsed = parseGlobalArgs(argv);
    return (
      parsed.values.prompt === undefined &&
      parsed.values.target === undefined &&
      !parsed.values.help &&
      !parsed.values.version &&
      (parsed.positionals[0] === "app-server" || parsed.positionals[0] === "agent-server")
    );
  } catch {
    // 无效参数由 run 格式化；明确的协议命令仍保护 stdout。
    return argv[0] === "app-server" || argv[0] === "agent-server";
  }
}

const DISALLOWED_TOOLS_FLAGS = new Set(["--disallowedTools", "--disallowed-tools"]);

export const extractDisallowedToolsArgs = (
  argv: readonly string[],
): { args: string[]; toolDisallowlist?: readonly string[] } => {
  const args: string[] = [];
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equalsMatch = arg.match(/^(--disallowedTools|--disallowed-tools)=(.*)$/);
    if (equalsMatch) {
      values.push(equalsMatch[2] ?? "");
      continue;
    }

    if (!DISALLOWED_TOOLS_FLAGS.has(arg)) {
      args.push(arg);
      continue;
    }

    let consumed = false;
    while (index + 1 < argv.length && !isCliOptionToken(argv[index + 1])) {
      values.push(argv[index + 1]);
      index += 1;
      consumed = true;
    }
    if (!consumed) {
      throw new Error(`${arg} requires at least one tool.`);
    }
  }

  return {
    args,
    toolDisallowlist: normalizeCliToolRuleList(values),
  };
};

const isCliOptionToken = (value: string): boolean => value === "--" || /^-[^-]?|^--/.test(value);

const normalizeCliToolRuleList = (values: readonly string[]): readonly string[] | undefined => {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of splitCliToolRules(value)) {
      const rule = normalizeCliToolRule(part);
      if (!rule || seen.has(rule)) continue;
      seen.add(rule);
      normalized.push(rule);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
};

const splitCliToolRules = (value: string): readonly string[] => {
  const rules: string[] = [];
  let current = "";
  let inToolArgs = false;
  const flush = () => {
    const rule = current.trim();
    if (rule) rules.push(rule);
    current = "";
  };

  for (const char of value) {
    switch (char) {
      case "(":
        inToolArgs = true;
        current += char;
        break;
      case ")":
        inToolArgs = false;
        current += char;
        break;
      case ",":
        if (inToolArgs) {
          current += char;
        } else {
          flush();
        }
        break;
      case " ":
        if (inToolArgs) {
          current += char;
        } else {
          flush();
        }
        break;
      default:
        current += char;
        break;
    }
  }
  flush();
  return rules;
};

const normalizeCliToolRule = (rule: string): string => {
  if (!rule) return "";
  if (rule === "web_search") return "WebSearch";
  if (rule.startsWith("web_search(")) return `WebSearch${rule.slice("web_search".length)}`;
  return rule;
};
