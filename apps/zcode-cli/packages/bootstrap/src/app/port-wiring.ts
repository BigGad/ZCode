import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePath } from "@zcode/adapters/config";
import { loadOcrRuntimeSettings } from "@zcode/adapters/config";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createLocalInfraPort } from "@zcode/adapters/local-infra";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createWorkspaceResourceIndexPort } from "@zcode/adapters/storage";
import type {
  DegradationPolicy,
  ExecutionPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  LocalInfraPort,
  Logger,
  McpPort,
  PdfDocumentPort,
  ProviderEndpointRoutingPort,
  SessionMailboxPort,
  WorkspaceResourceIndexPort,
} from "@zcode/contracts";
import { createSessionEvent, SessionEventType, type SessionId, type TraceContext } from "@zcode/contracts";
import type { AgentRuntime, AgentRuntimeConfig } from "@zcode/core";
import type { ConfigResult } from "@zcode/adapters/config";
import { createWorkspaceMcpTrust } from "../workspace-mcp-trust/index.js";
import { withOfficialCommandEnv } from "../official-command-endpoint/index.js";
import { resolveMcpNodeFallbackProvider } from "./mcp-node-fallback.js";
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
  cliStorageRoot: string;
  appVersion: string;
  logger: Logger;
  configuredMcpServers: Record<string, unknown>;
  sessionId: SessionId;
  traceContext: TraceContext;
  /** runtime 在端口装配之后才创建；端口回调只能通过它取当前实例。 */
  resolveRuntime: () => AgentRuntime | undefined;
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
  /** 本地解析基础设施端口（能力供给层的依赖）。 */
  localInfraPort: LocalInfraPort;
  /** 能力不可用时的降级策略（默认 `error`）。 */
  localInfraDegradation: DegradationPolicy;
}

export function wirePorts(context: WirePortsContext): WiredPorts {
  const {
    options,
    configResult,
    runtimeConfig,
    workingDirectory,
    storageRoot,
    cliStorageRoot,
    appVersion,
    logger,
    sessionId,
    traceContext,
    resolveRuntime,
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

  const rawMcpPort =
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
          nodeFallback: resolveMcpNodeFallbackProvider({ cliStorageRoot, logger }),
          workingDirectory,
        })));
  // workspace 级 MCP 信任：未准入的 server 必须在端口边界被挡住，不能进入运行时。
  const mcpPort = rawMcpPort
    ? createWorkspaceMcpTrust({
        workingDirectory,
        workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
        userConfigPath: options.userConfigPath,
        projectConfigPath: options.projectConfigPath,
        skipUserConfig: options.skipUserConfig,
        env: options.env,
        onAdmissionChanged: async (payload) => {
          const runtime = resolveRuntime();
          if (!runtime) return;
          await runtime.appendEvent(
            createSessionEvent(
              SessionEventType.WorkspaceMcpAdmissionUpdated,
              sessionId,
              payload,
              { traceId: traceContext.traceId },
            ),
            traceContext,
          );
        },
      }).guard(rawMcpPort)
    : undefined;
  const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;

  const baseExecutionPort =
    options.executionPort ??
    createNodeExecutionAdapter({
      onToolExecResource: options.onToolExecResource,
      network: {
        httpProxy: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      },
      outputRootDir: join(storageRoot, "cli", "exec"),
      bashOutputTempDir: tmpdir(),
      processEnv: env,
    });
  // 本 app 只服务一个 session：它的子进程统一带上这个 session 的官方命令端点 env。
  const officialCommandEnv = options.officialCommandEnv;
  const officialCommandIdentity = options.runtimeConfig?.memory?.workspaceIdentity;
  const officialCommandWorkspace = {
    workspacePath: workingDirectory,
    ...(officialCommandIdentity ? { workspaceIdentity: officialCommandIdentity } : {}),
  };
  const executionPort = officialCommandEnv
    ? withOfficialCommandEnv(
        baseExecutionPort,
        () => officialCommandEnv(sessionId, officialCommandWorkspace),
        logger,
      )
    : baseExecutionPort;
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

  // 本地解析基础设施（spec：docs/design/v2/capability-provisioning.md §8.3）：
  // 能力供给层靠它体检本机引擎并在模型读不了 PDF 时自动走本地 OCR。
  // ⚠️ 配置只在这里读一次 —— `zcode ocr` 命令组与 runtime 必须看到同一份引擎路径与降级策略。
  const ocrSettings = loadOcrRuntimeSettings(workingDirectory, {
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
  });
  const localInfraPort =
    options.localInfraPort ??
    createLocalInfraPort({
      execution: executionPort,
      fileSystem: fileSystemPort,
      config: ocrSettings.infra,
      pdf: pdfDocumentPort,
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
    localInfraPort,
    localInfraDegradation: ocrSettings.degradation,
  };
}