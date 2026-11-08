import type { LocalInfraConfig, LocalInfraPort, MineruProxyPolicy } from "@zcode/contracts";
import { createLocalInfraPort } from "@zcode/adapters/local-infra";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { loadFileConfig, loadProjectConfigs } from "@zcode/adapters/config";
import { parseInfrManageArgs } from "./arguments.js";
import { runDoctorCommand } from "./doctor-command.js";
import { runModelsDownloadCommand } from "./models-command.js";
import { runParseCommand } from "./parse-command.js";
import { INFR_EXIT_ERROR, INFR_EXIT_OK, type InfrManageContext } from "./output.js";

/**
 * `zcode-infr-manage` 的组合根。
 *
 * ⚠️ **本文件不得 import `run.ts` / `@zcode/bootstrap` / `@zcode/core`** ——
 * 那会求值 Agent 运行时、工具注册表与工作流模块，把整套业务依赖打进这个
 * 独立二进制（M1 / §7.3 的唯一可执行约束）。
 *
 * ⚠️ **端口依赖由这里注入**（`ExecutionPort` / `FileSystemPort`）——实现内部
 * 绝不允许 new 一个 ExecutionPort，否则会出现两个实例，代理策略与超时各走一套。
 */
export interface InfrManageRuntime {
  readonly port: LocalInfraPort;
  /** 释放运行时持有的资源（可选）。 */
  readonly dispose?: () => Promise<void> | void;
}

export interface InfrManageOptions {
  /** 项目配置发现的工作目录；默认 `process.cwd()`。 */
  readonly workingDirectory?: string;
  /** 注入自定义运行时（测试用）。不给则按默认装配。 */
  readonly createRuntime?: () => InfrManageRuntime | Promise<InfrManageRuntime>;
}

export const INFR_MANAGE_USAGE = `zcode-infr-manage —— 本地模型 / 解析基础设施管理

用法：
  zcode-infr-manage doctor [--json]
  zcode-infr-manage parse --path <文件> [--output <目录>] [--tier <档位>] [--json]
  zcode-infr-manage models download --tier <basic|standard> [--source <源>] [--json]

子命令：
  doctor           本地解析引擎体检（只读，不下载任何权重）
  parse            解析一份 PDF 或图片，产物落盘到工作区
  models download  下载指定档位的模型权重

旗标：
  --path <文件>    待解析文件（parse 必填）
  --output <目录>  产物输出目录（默认 <源文件名>.mineru/）
  --tier <档位>    解析档位：flash / basic / standard / advanced
  --source <源>    模型源：auto / huggingface / modelscope
  --json           以单个 JSON 对象输出到 stdout
  --help, -h       显示本帮助

说明：
  - ZCode 只检测并调用本机已装好的 MinerU，不负责安装（引擎与 Python 环境由用户自装）。
  - 引擎不可用时 doctor 会给出装法；解析时按档位链降级并在 warnings 中告知。
`;

/**
 * 命令面入口。
 *
 * ⚠️ **退出码语义由本层决定**：底层模块不调 `process.exit`、不决定退出码。
 */
export async function runInfrManage(
  ctx: InfrManageContext,
  argv: readonly string[],
  options: InfrManageOptions = {},
): Promise<number> {
  const command = parseInfrManageArgs(argv);
  if (command.kind === "help") {
    ctx.stdout.write(INFR_MANAGE_USAGE);
    return INFR_EXIT_OK;
  }
  if (command.kind === "error") {
    ctx.stderr.write(`${command.message}\n\n${INFR_MANAGE_USAGE}`);
    return INFR_EXIT_ERROR;
  }

  const runtime = await (options.createRuntime ?? (() => createDefaultRuntime(options)))();
  try {
    switch (command.kind) {
      case "doctor":
        return await runDoctorCommand(ctx, runtime.port, { json: command.json });
      case "parse":
        return await runParseCommand(ctx, runtime.port, {
          json: command.json,
          path: command.path,
          ...(command.output !== undefined ? { output: command.output } : {}),
          ...(command.tier !== undefined ? { tier: command.tier } : {}),
        });
      case "models-download":
        return await runModelsDownloadCommand(ctx, runtime.port, {
          json: command.json,
          tier: command.tier,
          ...(command.source !== undefined ? { source: command.source } : {}),
        });
      default: {
        const exhaustive: never = command;
        throw new Error(`未处理的命令：${JSON.stringify(exhaustive)}`);
      }
    }
  } finally {
    await runtime.dispose?.();
  }
}

/**
 * 默认装配：`ExecutionPort` / `FileSystemPort` / `PdfDocumentPort` 三个适配器
 * 都在这里建一次，端口与子命令共用同一批实例。
 *
 * ⚠️ **PDF 页数适配器是可选依赖**（poppler 的 `pdfinfo` 不是 ZCode 的依赖）：
 * 缺它时解析仍然可用，超时预算按 1 页计。
 */
async function createDefaultRuntime(options: InfrManageOptions): Promise<InfrManageRuntime> {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const execution = createNodeExecutionAdapter();
  const fileSystem = createNodeFileSystemAdapter();
  const config = loadLocalInfraConfig(workingDirectory);
  const port = createLocalInfraPort({
    execution,
    fileSystem,
    config,
    pdf: createPopplerPdfDocumentAdapter({ executionPort: execution }),
  });
  return { port };
}

/**
 * 读 `ocr.*` 配置键。
 *
 * ⚠️ **层级**：项目级配置 > 用户级配置（`~/.zcode/cli/config.json`）。
 * 项目级走既有的配置发现（`.agents` 协议 / `.zcode/config.json` / `zcode.json`），
 * 不自己拼路径 —— 配置发现只有一处所有者。
 *
 * ⚠️ **只取 `mineruPath` / `mineruProxy`**：`enginePath` / `popplerPath` 是
 * tesseract 路线（`ocr-local.md` §9）的旋钮，v1 不接。
 */
export function loadLocalInfraConfig(workingDirectory: string): LocalInfraConfig {
  const user = loadFileConfig(undefined, { scope: "user" });
  const project = loadProjectConfigs(workingDirectory);

  let merged: LocalInfraConfig = {};
  for (const layer of [user.config.ocr, ...project.files.map((file) => file.config.ocr)]) {
    merged = {
      ...merged,
      ...pickLocalInfraFields(layer),
    };
  }
  return merged;
}

function pickLocalInfraFields(
  layer:
    | {
        mineruPath?: string;
        mineruProxy?: MineruProxyPolicy;
      }
    | undefined,
): LocalInfraConfig {
  if (layer === undefined) return {};
  return {
    ...(layer.mineruPath !== undefined ? { mineruPath: layer.mineruPath } : {}),
    ...(layer.mineruProxy !== undefined ? { mineruProxy: layer.mineruProxy } : {}),
  };
}
