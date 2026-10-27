import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionId, TraceContext } from "@zcode/contracts";
import { createRootTraceContext } from "@zcode/contracts";
import {
  createConfig,
  createFfmpegRtspSegmenter,
  createFfmpegVideoFrameAdapter,
  createJimpImageProcessorAdapter,
  createNodeExecutionAdapter,
  createNodeToolArtifactStore,
  createWorkspaceResourceIndexPort,
  loadStreamConfig,
  resolvePath,
  resolveStreamConfigPath,
  type StreamConfigEntry,
} from "@zcode/adapters";
import {
  createStreamMonitor,
  streamMonitorSessionId,
  type StreamAlertRow,
  type StreamMonitor,
  type StreamMonitorCapture,
  type StreamMonitorDeps,
} from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import {
  isDeadlineAbort,
  isProcessAlive,
  parseWatchDeadline,
  readWatchPid,
  registerWatchDaemon,
  spawnStreamWatchDaemon,
  StreamWatchDeadlineError,
  watchLogFilePath,
} from "./stream-watch-daemon.js";

/**
 * `zcode stream analyze|watch` 的运行时装配层（stream-command.ts 的监控分支）。
 *
 * 装配三块：
 *  - 分析 app：provider registry + 刻意缺省 permissionBroker（core 退到 deny
 *    broker，prompt-command headless 先例），监控分析 turn 不能执行任何工具；
 *  - segment 管线 ports：ffmpeg 抽帧 / segmenter / artifact store / 资源索引，
 *    路径约定与 bootstrap port-wiring 一致（storageRoot/cli/...）；
 *  - monitor 循环：createStreamMonitor（core），runAnalysisTurn 以 sendInput 注入。
 *
 * 安全边界（stream-input.md 凭据管理节）：RTSP URL 只透传给 ffmpeg argv 与
 * capture.start，不进日志 / 错误文本 / 分析 prompt。
 */

const ANALYZE_FIRST_SEGMENT_TIMEOUT_MS = 120_000;
export const STREAM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;

/** 告警 JSONL 目录（spec：~/.zcode/cli/stream-events）。 */
export function resolveAlertStoreDir(): string {
  return join(homedir(), ".zcode", "cli", "stream-events");
}

type StreamZCodeApp = Awaited<
  ReturnType<Awaited<ReturnType<typeof loadBootstrapModule>>["createZCodeApp"]>
>;

interface StreamRuntimeHandle {
  app: StreamZCodeApp;
  dispose(): Promise<void>;
}

export async function runStreamMonitorCommand(
  ctx: RunContext,
  options: GlobalOptions,
  streamOptions: {
    subcommand?: string;
    stream?: string;
    once?: boolean;
    config?: string;
    version?: string;
    duration?: string;
    until?: string;
    forever?: boolean;
    daemon?: boolean;
  },
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const once = streamOptions.subcommand === "analyze" || streamOptions.once === true;
  if (
    once &&
    (streamOptions.forever === true ||
      streamOptions.duration !== undefined ||
      streamOptions.until !== undefined)
  ) {
    throw new Error("--duration/--until/--forever are only supported with `zcode stream watch`.");
  }
  const configPath = resolveStreamConfigPath(streamOptions.config, env);
  const entry = requireStreamEntry(await loadStreamConfig(configPath), streamOptions.stream);
  const workingDirectory = process.cwd();
  const workspaceKey = workingDirectory;

  // --forever 父进程分支：校验配置在前（错误在前台可见），spawn detached 子进程
  // 后立即返回；子进程带 --daemon 内部旗标重新进入本函数走完整装配。
  if (streamOptions.forever === true && streamOptions.daemon !== true) {
    // 前台先校验时长旗标与配置：参数/配置错误要在前台可见，不能落进后台日志才发现。
    parseWatchDeadline(streamOptions);
    // 防双 daemon：同流已常驻时拒绝重复启动（两个 ffmpeg 争抢同一 outDir 会
    // 覆盖 segment 文件并撞 marker 编号）。
    const existingPid = await readWatchPid(entry.id);
    if (existingPid !== undefined && isProcessAlive(existingPid)) {
      throw new Error(
        `stream watch is already running for "${entry.id}" (pid ${existingPid}); stop it first: zcode stream stop --stream ${entry.id}`,
      );
    }
    const logPath = watchLogFilePath(entry.id);
    const pid = await spawnStreamWatchDaemon({
      streamId: entry.id,
      logPath,
      env,
      parentArgv: process.argv,
    });
    if (pid < 0) {
      throw new Error("failed to spawn background watch process.");
    }
    ctx.stdout.write(
      `stream watch started in background: pid=${pid}\nlog: ${logPath}\nstop: zcode stream stop --stream ${entry.id}\n`,
    );
    return 0;
  }

  const abortController = new AbortController();
  const onSignal = (): void => abortController.abort(new Error("stream command interrupted"));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // --duration/--until 定时结束（watch 前台与 daemon 子进程共用）。
  const deadlineMs = parseWatchDeadline(streamOptions);
  const deadlineTimer =
    deadlineMs === undefined
      ? undefined
      : setTimeout(() => {
          abortController.abort(new StreamWatchDeadlineError());
        }, Math.max(0, deadlineMs - Date.now()));
  deadlineTimer?.unref?.();
  // daemon 子进程：pid 文件轮询是跨平台优雅停止通道（stream stop 移除 pid 文件）。
  const daemonHandle =
    streamOptions.daemon === true ? registerWatchDaemon(entry.id, () => onSignal()) : undefined;

  let runtime: StreamRuntimeHandle | undefined;
  try {
    runtime = await createStreamAnalysisApp(options, streamOptions.version, env);
    const runtimeHandle = runtime;
    const pipeline = await createStreamPipelineDeps({ entry, workspaceKey, env });
    const segmenter = createFfmpegRtspSegmenter({
      executionPort: pipeline.executionPort,
      ffmpegPath: env.ZCODE_STREAM_FFMPEG_PATH,
    });
    const capture: StreamMonitorCapture = {
      start: (signal) =>
        segmenter.start(
          {
            sourceUrl: entry.url,
            outDir: join(pipeline.streamCacheDir, "segments"),
            segmentSeconds: entry.segmentSeconds,
            transport: entry.transport,
            trace: pipeline.trace,
          },
          signal ? { signal } : undefined,
        ),
      watchClosedSegments: (signal) => segmenter.watchClosedSegments(signal),
      readSegment: (path) => segmenter.readSegment(path),
      deleteSegment: (path) => segmenter.deleteSegment(path),
      stop: () => segmenter.stop(),
    };

    const monitor = createStreamMonitor({
      stream: {
        id: entry.id,
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        url: entry.url,
        transport: entry.transport,
        segmentSeconds: entry.segmentSeconds,
        ...(entry.policyTag !== undefined ? { policyTag: entry.policyTag } : {}),
        ...(entry.analysisPrompt !== undefined ? { analysisPrompt: entry.analysisPrompt } : {}),
      },
      monitorId: streamMonitorSessionId(entry.id),
      workspaceKey,
      workspacePath: workingDirectory,
      stateDir: join(pipeline.streamCacheDir, "state"),
      alertStoreDir: resolveAlertStoreDir(),
      capture,
      pipeline: pipeline.pipelineDeps,
      runAnalysisTurn: async (req) => {
        const result = await runtimeHandle.app.sendInput(
          {
            text: req.prompt,
            attachments: req.imageDataUrls.map((dataUrl) => ({
              type: "image" as const,
              content: dataUrl,
              mimeType: "image/jpeg",
            })),
          },
          { abortSignal: req.signal },
        );
        if (result.kind !== "started_turn") {
          throw new Error("analysis turn was not admitted");
        }
        const turn = await result.completion;
        return turn.response;
      },
      onAlert: (alert) => {
        if (
          alert.kind === "lifecycle" ||
          alert.status === "anomaly" ||
          alert.status === "analysis_failed"
        ) {
          ctx.stdout.write(
            `[stream:${alert.streamId}] ${alert.status}${alert.deduplicated ? " (dedup)" : ""}\n`,
          );
        }
      },
      reconnectDelaysMs: once ? [0] : undefined,
    });

    if (once) {
      return await analyzeSingleSegment(ctx, monitor, abortController);
    }
    const { stoppedReason } = await monitor.run(abortController.signal);
    if (stoppedReason === "exhausted") {
      ctx.stderr.write("stream monitor gave up after repeated failures\n");
      return 1;
    }
    if (isDeadlineAbort(abortController.signal)) {
      ctx.stderr.write("stream watch deadline reached; stopped\n");
    }
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    await daemonHandle?.dispose();
    await runtime?.dispose();
  }
}

function requireStreamEntry(
  config: Awaited<ReturnType<typeof loadStreamConfig>>,
  streamId: string | undefined,
): StreamConfigEntry {
  if (streamId === undefined || !STREAM_ID_PATTERN.test(streamId)) {
    throw new Error("A valid --stream <id> is required (1-64 chars [a-zA-Z0-9_-]).");
  }
  const entry = config.streams.find((stream) => stream.id === streamId);
  if (entry === undefined) {
    throw new Error(`Stream "${streamId}" is not defined in ${config.path}.`);
  }
  if (!entry.enabled) {
    throw new Error(`Stream "${streamId}" is disabled in ${config.path}.`);
  }
  return entry;
}

/**
 * analyze --once：等到第一个新 analysis 事件（按 segmentSeq 判新），输出完整
 * 判定 JSON 后 abort 让 monitor 收尾（stop capture / stopped 事件）再退出。
 */
async function analyzeSingleSegment(
  ctx: RunContext,
  monitor: StreamMonitor,
  abortController: AbortController,
): Promise<number> {
  const before = new Set(
    (await monitor.alerts.query({ limit: 10_000 }))
      .filter((row) => row.kind === "analysis")
      .map((row) => row.segmentSeq ?? -1),
  );
  const runPromise = monitor.run(abortController.signal).catch(() => undefined);
  const deadline = Date.now() + ANALYZE_FIRST_SEGMENT_TIMEOUT_MS;
  let verdict: StreamAlertRow | undefined;
  while (verdict === undefined && !abortController.signal.aborted) {
    const all = await monitor.alerts.query({ limit: 10_000 });
    verdict = all.filter((row) => row.kind === "analysis" && !before.has(row.segmentSeq ?? -1)).at(-1);
    if (verdict !== undefined || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  abortController.abort(new Error("single segment analysis finished"));
  await runPromise;
  if (verdict === undefined) {
    ctx.stderr.write("timed out waiting for the first closed segment\n");
    return 1;
  }
  ctx.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  return verdict.status === "anomaly" ? 2 : 0;
}

// -----------------------------------------------
// 组装：分析 app（provider registry + deny 权限面）
// -----------------------------------------------

async function createStreamAnalysisApp(
  options: GlobalOptions,
  version: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<StreamRuntimeHandle> {
  const bootstrap = await loadBootstrapModule();
  const prepareTelemetry = bootstrap.prepareZCodeTelemetryEnv;
  const appEnv = prepareTelemetry
    ? await prepareTelemetry(env, {
        cliVersion: version ?? "0.0.0",
      })
    : env;
  const registryRuntime = await bootstrap.startProcessProviderRegistryRuntime(appEnv);
  let app: StreamZCodeApp | undefined;
  try {
    app = await bootstrap.createZCodeApp({
      env: appEnv,
      providerRegistry: registryRuntime.runtime.registryService,
      configuredDefaultModelSelection: registryRuntime.configuredDefaultModelSelection,
      ...(registryRuntime.configuredModelSelections
        ? {
            configuredModelSelections: registryRuntime.configuredModelSelections,
          }
        : {}),
      ...(registryRuntime.providerRuntimeHeadersPort
        ? { providerRuntimeHeadersPort: registryRuntime.providerRuntimeHeadersPort }
        : {}),
      uiLocale: options.locale,
      uiDetectedLocale: options.detectedLocale,
      runtimeConfig: {
        workingDirectory: process.cwd(),
      },
      // 刻意不注入 permissionBroker：core 退到 deny broker，
      // 监控分析 turn 只做判定，不能执行任何工具（安全红线）。
    });
    return {
      app,
      dispose: async () => {
        await app?.close?.().catch(() => undefined);
        registryRuntime.dispose();
      },
    };
  } catch (error) {
    registryRuntime.dispose();
    throw error;
  }
}

// -----------------------------------------------
// 组装：segment 管线 ports（与 bootstrap port-wiring 的路径约定一致）
// -----------------------------------------------

async function createStreamPipelineDeps(input: {
  entry: StreamConfigEntry;
  workspaceKey: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  executionPort: ReturnType<typeof createNodeExecutionAdapter>;
  streamCacheDir: string;
  trace: TraceContext;
  pipelineDeps: Omit<StreamMonitorDeps["pipeline"], "monitorSessionId" | "readSegment">;
}> {
  const configResult = createConfig({ workingDirectory: input.workspaceKey });
  // storage.dir 可能是 "~/..." 形态，必须走 resolvePath 展开（与 bootstrap create-app
  // 同一来源）；直接 resolve 会把 "~" 当字面目录，在 cwd 下创建 ./~/.zcode。
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const cliStorageRoot = basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
  const streamCacheDir = join(
    cliStorageRoot,
    "stream-cache",
    streamMonitorSessionId(input.entry.id),
  );
  const trace = createRootTraceContext({
    sessionId: streamMonitorSessionId(input.entry.id) as SessionId,
  });
  const executionPort = createNodeExecutionAdapter({ processEnv: input.env });
  const videoFramePort = createFfmpegVideoFrameAdapter({
    executionPort,
    ffmpegPath: input.env.ZCODE_STREAM_FFMPEG_PATH,
  });
  const resourceIndex = createWorkspaceResourceIndexPort({
    // 与 bootstrap port-wiring 一致：workspaceKey 短哈希作文件名。
    dbPath: join(
      cliStorageRoot,
      "resources",
      `${createHash("sha256").update(input.workspaceKey).digest("hex").slice(0, 16)}.db`,
    ),
  });
  return {
    executionPort,
    streamCacheDir,
    trace,
    pipelineDeps: {
      videoFramePort,
      imageProcessorPort: createJimpImageProcessorAdapter(),
      artifactStore: createNodeToolArtifactStore({
        rootDir: join(cliStorageRoot, "artifacts"),
        imageCacheRootDir: join(cliStorageRoot, "image-cache"),
        videoCacheRootDir: join(cliStorageRoot, "video-cache"),
      }),
      workspaceResourceIndex: resourceIndex,
      workspaceKey: input.workspaceKey,
      workspacePath: input.workspaceKey,
      ...(input.entry.policyTag !== undefined ? { policyTag: input.entry.policyTag } : {}),
    },
  };
}
