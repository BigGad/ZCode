import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolvePath } from "@zcode/adapters/config";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createWorkspaceResourceIndexPort } from "@zcode/adapters/storage";
import type {
  ExecutionPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  Logger,
  McpPort,
  PdfDocumentPort,
  ProviderEndpointRoutingPort,
  SessionMailboxPort,
  WorkspaceResourceIndexPort,
} from "@zcode/contracts";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { ConfigResult } from "@zcode/adapters/config";
import { isMessageEnabled } from "./app-config-options.js";
import type { ZCodeAppOptions } from "./types.js";

/**
 * 收集 createZCodeApp() 需要的运行时上下文，集中实例化所有 I/O 与运行时端口。
 * 后续 Phase 2-6 引入的新端口（audio / video / streaming / hardware / workspace resource index）
 * 一并加入此函数，避免 create-app.ts 继续增长。
 */
export interface WirePortsContext {
  options: ZCodeAppOptions;
  configResult: ConfigResult;
  runtimeConfig: AgentRuntimeConfig;
  workingDirectory: string;
  storageRoot: string;
  appVersion: string;
  logger: Logger;
  configuredMcpServers: Record<string, unknown>;
}

export interface WiredPorts {
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort: PdfDocumentPort;
  fileSystemPort: FileSystemPort;
  httpClientPort: HttpClientPort;
  executionPort: ExecutionPort;
  ownsExecutionPort: boolean;
  sessionMailboxPort: SessionMailboxPort | undefined;
  mcpPort: McpPort | undefined;
  ownsMcpPort: boolean;
  providerEndpointRoutingPort: ProviderEndpointRoutingPort | undefined;
  workspaceResourceIndexPort: WorkspaceResourceIndexPort;
}

export function wirePorts(context: WirePortsContext): WiredPorts {
  const {
    options,
    configResult,
    runtimeConfig,
    workingDirectory,
    storageRoot,
    appVersion,
    logger,
  } = context;
  const env = options.env ?? process.env;

  const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();

  const messageEnabled = isMessageEnabled(env);
  const sessionMailboxPort =
    options.sessionMailboxPort ??
    (messageEnabled
      ? createNodeSessionMailboxAdapter({
          rootDir: resolvePath(env.ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox"),
        })
      : undefined);

  const mcpPort =
    options.mcpPort ??
    (runtimeConfig.mcp?.enabled === false
      ? undefined
      : (options.mcpPortFactory?.({ workingDirectory }) ??
        createMcpAdapter({
          clientVersion: appVersion,
          env: options.env,
          logger,
          network: {
            httpProxy: configResult.config.network.httpProxy,
            noProxy: configResult.config.network.noProxy,
            caCertFile: configResult.config.network.caCertFile,
          },
          workingDirectory,
        })));
  const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;

  const executionPort =
    options.executionPort ??
    createNodeExecutionAdapter({
      onToolExecResource: options.onToolExecResource,
      network: {
        httpProxy: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      },
      outputRootDir: join(storageRoot, "cli", "exec"),
      processEnv: env,
    });
  const ownsExecutionPort = options.executionPort === undefined;

  const pdfDocumentPort =
    options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
  // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
  const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
  const httpClientPort =
    options.httpClientPort ??
    createNodeWebFetchHttpClientAdapter({
      env,
      timeoutMs: configResult.config.network.timeout,
      proxyUrl: configResult.config.network.httpProxy,
      noProxy: configResult.config.network.noProxy,
      caCertFile: configResult.config.network.caCertFile,
    });
  const providerEndpointRoutingPort = options.providerEndpointRoutingPort;

  // workspace 资源库：跨 session 持久，SQLite 一个 workspace 一个文件。workspaceKey 统一
  // `workspaceIdentity?.trim() || workspacePath || workingDirectory`；文件名用短哈希避免路径 /
  // remote identity 里的非法字符（`:` `/` 等）写不进文件名。
  const workspaceIdentity = runtimeConfig.memory?.workspaceIdentity?.trim();
  const workspaceResourceIndexDbKey =
    workspaceIdentity || runtimeConfig.workspacePath || workingDirectory;
  const workspaceResourceIndexPort = createWorkspaceResourceIndexPort({
    dbPath: join(
      storageRoot,
      "cli",
      "resources",
      `${createHash("sha256").update(workspaceResourceIndexDbKey).digest("hex").slice(0, 16)}.db`,
    ),
    logger,
  });

  return {
    imageProcessorPort,
    pdfDocumentPort,
    fileSystemPort,
    httpClientPort,
    executionPort,
    ownsExecutionPort,
    sessionMailboxPort,
    mcpPort,
    ownsMcpPort,
    providerEndpointRoutingPort,
    workspaceResourceIndexPort,
  };
}