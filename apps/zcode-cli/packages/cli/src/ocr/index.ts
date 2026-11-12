import type { FileSystemPort, LocalInfraConfig, LocalInfraPort } from "@zcode/contracts";
import { createLocalInfraPort } from "@zcode/adapters/local-infra";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { loadOcrRuntimeSettings } from "@zcode/adapters/config";
import { parseOcrArgs, type OcrCommandInput } from "./arguments.js";
import { runDoctorCommand } from "./doctor-command.js";
import { runModelsDownloadCommand } from "./models-command.js";
import { runParseCommand } from "./parse-command.js";
import { OCR_EXIT_ERROR, OCR_EXIT_OK, type OcrContext } from "./output.js";

/**
 * `zcode ocr` 的组合根。
 *
 * ⚠️ **本组是 `zcode` 的子命令组**（spec §7.3）—— 与 `zcode` 主入口同进程，
 * 复用主入口的分派表、退出码、i18n 与遥测；**发行链不需要第二个 bin**。
 *
 * ⚠️ **端口依赖由这里注入**（`ExecutionPort` / `FileSystemPort`）——实现内部
 * 绝不允许 new 一个 ExecutionPort，否则会出现两个实例，代理策略与超时各走一套。
 */
export interface OcrRuntime {
  readonly port: LocalInfraPort;
  /**
   * 文件系统端口（sidecar 的指纹、读写）。
   * ⚠️ **与 `port` 用同一个实例** —— 命令面不许自己 new 一个 `FileSystemPort`，
   * 会出现两套原子写与路径规范化。
   */
  readonly fileSystem: FileSystemPort;
  /** 释放运行时持有的资源（可选）。 */
  readonly dispose?: () => Promise<void> | void;
}

export interface OcrCommandOptions {
  /** 项目配置发现的工作目录；默认 `process.cwd()`。 */
  readonly workingDirectory?: string;
  /** 注入自定义运行时（测试用）。不给则按默认装配。 */
  readonly createRuntime?: () => OcrRuntime | Promise<OcrRuntime>;
}

export const OCR_USAGE = `zcode ocr —— 本地 OCR / 文档解析能力面

用法：
  zcode ocr doctor [--json]
  zcode ocr parse --path <文件> [--output <目录>] [--tier <档位>] [--force] [--pdf-password <密码>] [--json]
  zcode ocr models download --tier <basic|standard> [--source <源>] [--json]

子命令：
  doctor           本地解析引擎体检（只读，不下载任何权重）
  parse            解析一份 PDF 或图片，产物落盘到工作区
  models download  下载指定档位的模型权重

旗标：
  --path <文件>    待解析文件（parse 必填）
  --output <目录>  产物输出目录（默认 <源文件名>.mineru/）
  --tier <档位>    解析档位：flash / basic / standard / advanced
  --source <源>    模型源：auto / huggingface / modelscope
  --force          忽略 sidecar 缓存，强制重算并覆盖
  --pdf-password <密码>  加密 PDF 的密码（只经 argv 传递，不落盘、不入日志）
  --json           以单个 JSON 对象输出到 stdout
  --help, -h       显示本帮助

产物：
  - 解析成功后在源文件旁写 <源文件名>.zcode-ocr.json（sidecar），
    内含逐页成分与逐元素信息；下次同样的解析会命中它（源文件内容变了会自动重算）。
  - sidecar 里的一切路径都是相对路径：artifactsDir 相对 sidecar 所在目录，
    产物路径相对 artifactsDir。

说明：
  - ZCode 只检测并调用本机已装好的 MinerU，不负责安装（引擎与 Python 环境由用户自装）。
  - 引擎不可用时 doctor 会给出装法；解析时按档位链降级并在 warnings 中告知。
  - --json 时 stdout 只有信封一个 JSON 对象，进度走 stderr（每行一个 NDJSON 事件）。
`;

/**
 * 命令面入口。
 *
 * ⚠️ **退出码语义由本层决定**：底层模块不调 `process.exit`、不决定退出码。
 */
export async function runOcrCommand(
  ctx: OcrContext,
  input: OcrCommandInput,
  options: OcrCommandOptions = {},
): Promise<number> {
  const command = parseOcrArgs(input);
  if (command.kind === "help") {
    ctx.stdout.write(OCR_USAGE);
    return OCR_EXIT_OK;
  }
  if (command.kind === "error") {
    ctx.stderr.write(`${command.message}\n\n${OCR_USAGE}`);
    return OCR_EXIT_ERROR;
  }

  const runtime = await (options.createRuntime ?? (() => createDefaultRuntime(options)))();
  try {
    switch (command.kind) {
      case "doctor":
        return await runDoctorCommand(ctx, runtime.port, { json: command.json });
      case "parse":
        return await runParseCommand(ctx, runtime.port, runtime.fileSystem, {
          json: command.json,
          path: command.path,
          ...(command.output !== undefined ? { output: command.output } : {}),
          ...(command.tier !== undefined ? { tier: command.tier } : {}),
          ...(command.force !== undefined ? { force: command.force } : {}),
          ...(command.pdfPassword !== undefined ? { pdfPassword: command.pdfPassword } : {}),
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
async function createDefaultRuntime(options: OcrCommandOptions): Promise<OcrRuntime> {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const execution = createNodeExecutionAdapter();
  const fileSystem = createNodeFileSystemAdapter();
  const config = loadOcrRuntimeSettings(workingDirectory).infra;
  const port = createLocalInfraPort({
    execution,
    fileSystem,
    config,
    pdf: createPopplerPdfDocumentAdapter({ executionPort: execution }),
  });
  return { port, fileSystem };
}

/**
 * 读 `ocr.*` 配置键。
 *
 * ⚠️ **层级与字段挑选只有一处所有者**：`@zcode/adapters/config` 的
 * `loadOcrRuntimeSettings`（spec：capability-provisioning.md §8.2）。
 * 命令面与 runtime 的能力供给层必须看到**同一份**引擎路径与降级策略，
 * 否则 `zcode ocr doctor` 体检出来的环境和实际用的不是一套。
 *
 * ⚠️ **只取 `mineruPath` / `mineruProxy`**：`enginePath` / `popplerPath` 是
 * tesseract 路线（`ocr-local.md` §9）的旋钮，v1 不接。
 */
export function loadLocalInfraConfig(workingDirectory: string): LocalInfraConfig {
  return loadOcrRuntimeSettings(workingDirectory).infra;
}
