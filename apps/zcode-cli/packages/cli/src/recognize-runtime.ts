import { createRootTraceContext, type AgentOutput, type SessionId, type TraceId } from "@zcode/contracts";
import { createDenyPermissionBroker } from "@zcode/core";
import { resolveConfiguredCapabilityModelSelections } from "@zcode/provider";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { GlobalOptions } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { createImageRecognizerAgentProfile, IMAGE_RECOGNIZER_AGENT_TYPE } from "./recognize-agent.js";
import type { ImageModelCandidate } from "./recognize-model.js";
import { buildRecognizeDispatchPrompt, parseRecognizeResult, type RecognizeMode, type RecognizeResult } from "./recognize-schema.js";
import type { RecognizeProgressIdentity } from "./recognize-progress.js";

/**
 * `zcode recognize` 的运行时装配（image-recognition-cli.md「State Owners」节）。
 *
 * 与 `stream-monitor-runner.ts` 同款 bootstrap 路径，但两处刻意不同：
 *  - 这里**必须**有可用的 Read 权限（子代理要读图），所以注入一个只放行 `Read` 的 broker；
 *  - `autoBackgroundMs: 0` 强制前台：本命令的契约是「跑完再聚合」，中途转后台会让结果集
 *    在打印时残缺。
 */

/** 子代理唯一需要的工具。其余工具委托回同一个 deny broker，不重写拒绝语义。 */
const RECOGNIZE_ALLOWED_TOOL = "Read";

export function createRecognizePermissionBroker(): NonNullable<
  ZCodeAppOptions["permissionBroker"]
> {
  const denyBroker = createDenyPermissionBroker();
  return {
    requestPermission: async (request, options) => {
      if (request.toolName !== RECOGNIZE_ALLOWED_TOOL) {
        return await denyBroker.requestPermission(request, options);
      }
      return {
        decision: "allow",
        reason: "zcode recognize auto-approves Read: the recognizer agent is read-only by construction.",
        resolvedAt: new Date(),
      };
    },
  };
}

export interface RecognizeRuntime {
  app: Awaited<ReturnType<Awaited<ReturnType<typeof loadBootstrapModule>>["createZCodeApp"]>>;
  candidates: readonly ImageModelCandidate[];
  /** 能力模型配置里的图片理解选择（capability-model-selection.md §6）。 */
  configuredCapability?: ModelSelection;
  configuredDefault?: ModelSelection;
  dispose: () => Promise<void>;
}

export async function createRecognizeRuntime(input: {
  options: GlobalOptions;
  version?: string;
  env: Record<string, string | undefined>;
  workingDirectory: string;
}): Promise<RecognizeRuntime> {
  const bootstrap = await loadBootstrapModule();
  const prepareTelemetry = bootstrap.prepareZCodeTelemetryEnv;
  const appEnv = prepareTelemetry
    ? await prepareTelemetry(input.env, { cliVersion: input.version ?? "0.0.0" })
    : input.env;
  const registryRuntime = await bootstrap.startProcessProviderRegistryRuntime(appEnv);
  let app: RecognizeRuntime["app"] | undefined;
  try {
    app = await bootstrap.createZCodeApp({
      env: appEnv,
      permissionBroker: createRecognizePermissionBroker(),
      providerRegistry: registryRuntime.runtime.registryService,
      configuredDefaultModelSelection: registryRuntime.configuredDefaultModelSelection,
      ...(registryRuntime.configuredCapabilityModelSelections
        ? {
            configuredCapabilityModelSelections:
              registryRuntime.configuredCapabilityModelSelections,
          }
        : {}),
      ...(registryRuntime.providerRuntimeHeadersPort
        ? { providerRuntimeHeadersPort: registryRuntime.providerRuntimeHeadersPort }
        : {}),
      uiLocale: input.options.locale,
      uiDetectedLocale: input.options.detectedLocale,
      runtimeConfig: {
        modelStreaming: "on",
        workingDirectory: input.workingDirectory,
        subagents: {
          // 识别必须跑完再聚合：中途转后台会让 Results 在打印时残缺。
          autoBackgroundMs: 0,
          profiles: [createImageRecognizerAgentProfile()],
        },
      },
    });
    const snapshot = registryRuntime.runtime.registryService.getSnapshot();
    // 能力模型要走 Registry 解析：既要确认模型真的支持图像，也要补齐可执行的推理档位
    // （Model Factory 只接受完整选择，缺档位会直接报错）。
    const capabilityModel = resolveConfiguredCapabilityModelSelections({
      configured: registryRuntime.configuredCapabilityModelSelections,
      registry: snapshot?.registry ?? { revision: 0, providers: [] },
    });
    return {
      app,
      candidates: snapshot === null ? [] : collectImageModelCandidates(snapshot.registry.providers),
      ...(registryRuntime.configuredDefaultModelSelection
        ? { configuredDefault: registryRuntime.configuredDefaultModelSelection }
        : {}),
      ...(capabilityModel.selections.image
        ? { configuredCapability: capabilityModel.selections.image }
        : {}),
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

/**
 * registry 快照 → 选择所需的候选集。能力位取自解析后的 `properties.inputFormat`，
 * 不是原始规则文件——规则是 match/overlay 的输入，只有解析结果才是某个具体模型的真实能力。
 */
function collectImageModelCandidates(
  providers: readonly { providerId: string; models: readonly { modelId: string; config: { properties?: { inputFormat?: { supportsImage?: boolean } } | null } }[] }[],
): ImageModelCandidate[] {
  const candidates: ImageModelCandidate[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      candidates.push({
        providerId: provider.providerId,
        modelId: model.modelId,
        supportsImage: model.config.properties?.inputFormat?.supportsImage === true,
      });
    }
  }
  return candidates;
}

export interface RecognizeImageDispatch {
  identity: RecognizeProgressIdentity;
  imagePath: string;
  mode: RecognizeMode;
  fields: readonly string[];
  questions: readonly string[];
  selection: ModelSelection;
  traceId: string;
  workingDirectory: string;
  signal?: AbortSignal;
}

/**
 * 跑一张图：派发 `image-recognizer` 子代理 → 取回文本 → 后置解析成 `RecognizeResult`。
 *
 * 任何抛出（子代理启动失败、provider 错误、`subagents.enabled=false`）都在这里被翻译成
 * failure envelope，而不是冒泡打断整批——单图失败不该影响兄弟（spec §8）。
 */
export async function dispatchRecognizeImage(
  runtime: RecognizeRuntime,
  dispatch: RecognizeImageDispatch,
): Promise<RecognizeResult> {
  const { prompt } = buildRecognizeDispatchPrompt({
    imagePath: dispatch.imagePath,
    mode: dispatch.mode,
    fields: dispatch.fields,
    questions: dispatch.questions,
  });

  let output: AgentOutput;
  try {
    output = await runtime.app.runtime.runSubagent(
      {
        // `sessionId` 是批次内合成的期望会话 id：runner 用它派生 trace 父子关系与输出目录，
        // 但子 runtime 的事实会话 id 由 runner 另铸（`sess_subagent_<agentId>`），进度归并
        // 走 `SubagentSpawned` 载荷里的 `childSessionId`，不依赖这里的值。
        // 两处 `as` 只还原 brand：id 由 `recognize-signer` 用 `createSessionId` 铸出，
        // 进度模块按字符串比较，故身份类型里不带 brand。
        sessionId: dispatch.identity.runtimeSessionId as SessionId,
        parentToolCallId: dispatch.identity.parentToolCallId,
        agentType: IMAGE_RECOGNIZER_AGENT_TYPE,
        description: `Recognize image ${dispatch.identity.index + 1}`,
        prompt,
        workingDirectory: dispatch.workingDirectory,
        workspaceRoot: dispatch.workingDirectory,
        trace: createRootTraceContext({
          traceId: dispatch.traceId as TraceId,
          sessionId: dispatch.identity.runtimeSessionId as SessionId,
          attributes: { "zcode.recognize.index": dispatch.identity.index },
        }),
      },
      {
        ...(dispatch.signal ? { signal: dispatch.signal } : {}),
        // background:"deny" 是 modelOverride 的必填位：单次执行的模型不能脱离父 loop 生命周期。
        modelOverride: { selection: dispatch.selection, background: "deny" },
      },
    );
  } catch (error) {
    return {
      status: "error",
      reason: "other",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (output.status !== "completed") {
    return {
      status: "error",
      reason: "other",
      message: `subagent did not complete in the foreground (status: ${output.status})`,
    };
  }

  return parseRecognizeResult({
    rawText: output.content.map((block) => block.text).join("\n"),
    mode: dispatch.mode,
    fields: dispatch.fields,
    questions: dispatch.questions,
  });
}
