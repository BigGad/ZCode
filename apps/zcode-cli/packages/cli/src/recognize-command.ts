import { matchesGlob } from "node:path";
import type { SessionEvent } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { GlobalOptions, GlobalOutputFormat, RunContext } from "@zcode/shared-types";
import { readRuntimeEventSubscriber } from "./runtime-event-subscriber.js";
import { pickRecognizeModelSelection, type ImageModelCandidate } from "./recognize-model.js";
import {
  createRecognizeProgressReporter,
  formatRecognizeProgressLine,
  type RecognizeProgressIdentity,
} from "./recognize-progress.js";
import {
  progressStreamLine,
  writePlan,
  writeResult,
  type RecognizeFinalItem,
  type RecognizePlan,
  type RecognizeSummary,
} from "./recognize-output.js";
import { createRecognizeSigner, imageBasename } from "./recognize-signer.js";
import {
  createRecognizeRuntime,
  dispatchRecognizeImage,
  type RecognizeImageDispatch,
} from "./recognize-runtime.js";
import type { RecognizeMode, RecognizeResult } from "./recognize-schema.js";
import { walkImageFolder } from "./recognize-walker.js";

/**
 * `zcode recognize <folder>` —— 图片文件夹批量多模态识别（spec:
 * `docs/design/v2/image-recognition-cli.md`）。
 *
 * 三段输出：Plan（识别前一次性）→ 实时进度（stderr，stream-json 走 stdout NDJSON）→
 * Results + Summary。多个子代理由 `Promise.allSettled` 语义的 worker pool 并发扇出，
 * 每个子代理的实时内容经会话事件订阅独立流到进度通道，不串行化。
 *
 * 退出码（spec §8）：0 至少一张成功 / 1 scope 错误、全部失败 / 2 目录缺失或无可识别图片。
 */

const MODES: readonly RecognizeMode[] = ["description", "qa", "structured"];
const DEFAULT_MAX_CONCURRENCY = 4;
const SCOPE_ERROR_SCHEMA = `--schema must be one of: ${MODES.join(", ")}.`;
const SCOPE_ERROR_FIELDS = "--fields can only be used with --schema structured.";
const SCOPE_ERROR_QUESTIONS = "--questions can only be used with --schema qa.";
const SCOPE_ERROR_STRUCTURED_NEEDS_FIELDS = "--schema structured requires at least one --fields.";
const SCOPE_ERROR_QA_NEEDS_QUESTIONS = "--schema qa requires at least one --questions.";
const SCOPE_ERROR_FOLDER = "A folder argument is required: zcode recognize <folder>.";

export interface RecognizeCommandOptions {
  folder?: string;
  model?: string;
  schema?: string;
  fields?: string[];
  questions?: string[];
  maxConcurrency?: string;
  recursive?: boolean;
  imageGlob?: string;
}

export interface RecognizeCommandDependencies {
  env?: Record<string, string | undefined>;
  version?: string;
  workingDirectory?: string;
  signal?: AbortSignal;
  now?: () => number;
  /** 注入点：直接给出模型候选与默认选择，跳过 provider registry（测试/嵌入用）。 */
  modelResolution?: {
    candidates: readonly ImageModelCandidate[];
    configuredModelType?: ModelSelection;
    configuredCapability?: ModelSelection;
    configuredDefault?: ModelSelection;
  };
  /** 注入点：单图识别实现；给了就不建 app、不订阅会话事件（测试/嵌入用）。 */
  recognizeImage?: (dispatch: RecognizeImageDispatch) => Promise<RecognizeResult>;
}

export async function runRecognizeCommand(
  ctx: RunContext,
  options: GlobalOptions,
  cmdOptions: RecognizeCommandOptions,
  deps: RecognizeCommandDependencies = {},
): Promise<number> {
  const format: GlobalOutputFormat = options.outputFormat ?? (options.json ? "json" : "text");
  const writers = {
    out: (line: string) => ctx.stdout.write(line),
    err: (line: string) => ctx.stderr.write(line),
  };
  // stream-json 是机器消费的：进度与结果同走 stdout NDJSON，stderr 不再双写。
  const progressWriter = format === "stream-json" ? writers.out : writers.err;

  const scope = resolveScope(cmdOptions);
  if ("error" in scope) {
    writers.err(`${scope.error}\n`);
    return 1;
  }

  const folder = scope.folder;
  let walk: Awaited<ReturnType<typeof walkImageFolder>>;
  try {
    walk = await walkImageFolder({ folder, recursive: cmdOptions.recursive === true });
  } catch (error) {
    writers.err(`Cannot read folder "${folder}": ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const images = applyGlobFilter(walk.images, cmdOptions.imageGlob);
  if (images.length === 0) {
    writers.err(`No supported images found in "${folder}".\n`);
    return 2;
  }

  const workingDirectory = deps.workingDirectory ?? process.cwd();
  const runtime =
    deps.recognizeImage === undefined
      ? await createRecognizeRuntime({
          options,
          ...(deps.version === undefined ? {} : { version: deps.version }),
          env: deps.env ?? process.env,
          workingDirectory,
        })
      : undefined;
  // 全批共用一个 traceId：子代理、事件、产物目录都挂在同一条链上（AGENTS.md 可观测性红线）。
  // 注入路径没有 app，就用同源的确定性种子，保持 id 可复现。
  const traceId = runtime?.app.traceId ?? `recognize:${folder}:${images.length}`;
  const signer = createRecognizeSigner(traceId);
  const identities: RecognizeProgressIdentity[] = images.map((imagePath, index) => ({
    index,
    subagentId: signer.agentLabel(index),
    shortId: signer.shortId(index),
    runtimeSessionId: signer.runtimeSessionId(index),
    parentToolCallId: signer.parentToolCallId(index),
  }));

  const now = deps.now ?? Date.now;
  const subscribeProgress = createProgressSink({
    format,
    identities,
    total: images.length,
    progressWriter,
    emitStreamLine: (line) => writers.out(line),
    now,
  });

  try {
    // 模型选择失败（没有视觉模型、`--model` 串非法、`--model-type` 指向不存在的类型）
    // 是用户可自行修正的输入问题，与 scope 错误同级：就地报错并返回 1，
    // 而不是把裸异常抛给顶层兜底。
    let selection: ModelSelection;
    try {
      if (runtime?.modelTypeError) throw new Error(runtime.modelTypeError);
      if (runtime?.capabilityOverrideError) throw new Error(runtime.capabilityOverrideError);
      const configuredModelType =
        deps.modelResolution?.configuredModelType ?? runtime?.configuredModelType;
      const configuredCapability =
        deps.modelResolution?.configuredCapability ?? runtime?.configuredCapability;
      selection = pickRecognizeModelSelection({
        ...(cmdOptions.model === undefined ? {} : { explicit: cmdOptions.model }),
        candidates: deps.modelResolution?.candidates ?? runtime?.candidates ?? [],
        ...(configuredModelType ? { configuredModelType } : {}),
        ...(configuredCapability ? { configuredCapability } : {}),
        ...(deps.modelResolution?.configuredDefault ?? runtime?.configuredDefault
          ? { configuredDefault: (deps.modelResolution?.configuredDefault ?? runtime?.configuredDefault)! }
          : {}),
      });
    } catch (error) {
      writers.err(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }

    const maxConcurrency = resolveMaxConcurrency(cmdOptions.maxConcurrency, images.length);
    const plan: RecognizePlan = {
      folder,
      totalImages: images.length,
      byExtension: walk.byExtension,
      model: `${selection.providerId}/${selection.modelId}`,
      schema: scope.mode,
      maxConcurrency,
      recursive: cmdOptions.recursive === true,
      ...(scope.fields.length > 0 ? { fields: scope.fields } : {}),
      ...(scope.questions.length > 0 ? { questions: scope.questions } : {}),
      estimatedSubagents: images.length,
    };
    writePlan(writers, format, plan);

    // 订阅必须在任何派发之前建立：第一个 SubagentSpawned 不能在 handler 就位前漏掉。
    const detach = subscribeProgress(runtime);
    const startedAt = now();
    let results: RecognizeFinalItem[];
    try {
      results = await runRecognitionBatch({
        images,
        identities,
        maxConcurrency,
        folder,
        workingDirectory,
        traceId,
        selection,
        mode: scope.mode,
        fields: scope.fields,
        questions: scope.questions,
        now,
        ...(deps.signal ? { signal: deps.signal } : {}),
        recognizeImage:
          deps.recognizeImage ??
          ((dispatch) => dispatchRecognizeImage(requireRuntime(runtime), dispatch)),
      });
    } finally {
      detach();
    }

    const summary: RecognizeSummary = {
      total: results.length,
      succeeded: results.filter((item) => item.status === "success").length,
      failed: results.filter((item) => item.status === "error").length,
      totalDurationMs: now() - startedAt,
    };
    writeResult(writers, format, { plan, results, summary });
    return summary.succeeded > 0 ? 0 : 1;
  } finally {
    await runtime?.dispose();
  }
}

function requireRuntime(
  runtime: Awaited<ReturnType<typeof createRecognizeRuntime>> | undefined,
): Awaited<ReturnType<typeof createRecognizeRuntime>> {
  if (runtime === undefined) {
    throw new Error("recognize runtime is unavailable: no injected recognizeImage and no app.");
  }
  return runtime;
}

type ScopeResolution =
  | { error: string }
  | { folder: string; mode: RecognizeMode; fields: string[]; questions: string[] };

function resolveScope(cmdOptions: RecognizeCommandOptions): ScopeResolution {
  const folder = cmdOptions.folder?.trim();
  if (folder === undefined || folder.length === 0) return { error: SCOPE_ERROR_FOLDER };

  const rawSchema = cmdOptions.schema?.trim() ?? "description";
  const mode = MODES.find((candidate) => candidate === rawSchema);
  if (mode === undefined) return { error: SCOPE_ERROR_SCHEMA };

  const fields = cmdOptions.fields ?? [];
  const questions = cmdOptions.questions ?? [];
  if (mode !== "structured" && fields.length > 0) return { error: SCOPE_ERROR_FIELDS };
  if (mode !== "qa" && questions.length > 0) return { error: SCOPE_ERROR_QUESTIONS };
  if (mode === "structured" && fields.length === 0) return { error: SCOPE_ERROR_STRUCTURED_NEEDS_FIELDS };
  if (mode === "qa" && questions.length === 0) return { error: SCOPE_ERROR_QA_NEEDS_QUESTIONS };

  return { folder, mode, fields, questions };
}

function resolveMaxConcurrency(raw: string | undefined, totalImages: number): number {
  const parsed = raw === undefined ? DEFAULT_MAX_CONCURRENCY : Number.parseInt(raw, 10);
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENCY;
  return Math.min(Math.max(requested, 1), Math.max(totalImages, 1));
}

function applyGlobFilter(images: readonly string[], glob: string | undefined): string[] {
  const pattern = glob?.trim();
  if (pattern === undefined || pattern.length === 0) return [...images];
  return images.filter((imagePath) => matchesGlob(imageBasename(imagePath), pattern));
}

/**
 * 进度通道。text/json 写 stderr 的 `[01/24 image-1 a3f] …` 行，stream-json 写 stdout 的
 * `{"type":"progress",…}` NDJSON；两种格式共用同一个 reporter，只有出口不同。
 */
function createProgressSink(input: {
  format: GlobalOutputFormat;
  identities: readonly RecognizeProgressIdentity[];
  total: number;
  progressWriter: (line: string) => void;
  emitStreamLine: (line: string) => void;
  now: () => number;
}): (
  runtime: Awaited<ReturnType<typeof createRecognizeRuntime>> | undefined,
) => () => void {
  const reporter = createRecognizeProgressReporter({
    identities: input.identities,
    now: input.now,
    emit: (line) => {
      if (input.format === "stream-json") {
        input.emitStreamLine(`${JSON.stringify(progressStreamLine(line, input.now()))}\n`);
        return;
      }
      input.progressWriter(formatRecognizeProgressLine(line, input.total));
    },
  });

  return (runtime) => {
    if (runtime === undefined) return () => undefined;
    const subscribe = readRuntimeEventSubscriber(runtime.app.runtime);
    if (subscribe === undefined) return () => undefined;
    return subscribe({ onSessionEvent: (event: SessionEvent) => reporter(event) });
  };
}

/**
 * 有界并发扇出。用 worker pool 而不是分片 `Promise.all`：每个 worker 取下一个未开始的
 * index，结果按下标回填，因此输出顺序与 walker 的确定性顺序一致，而并发数严格等于 limit。
 * 单张失败不会中断兄弟——`recognizeImage` 的契约就是「不抛，失败也返回 envelope」。
 */
async function runRecognitionBatch(input: {
  images: readonly string[];
  identities: readonly RecognizeProgressIdentity[];
  maxConcurrency: number;
  folder: string;
  workingDirectory: string;
  traceId: string;
  selection: ModelSelection;
  mode: RecognizeMode;
  fields: readonly string[];
  questions: readonly string[];
  now: () => number;
  signal?: AbortSignal;
  recognizeImage: (dispatch: RecognizeImageDispatch) => Promise<RecognizeResult>;
}): Promise<RecognizeFinalItem[]> {
  const results = Array.from<RecognizeFinalItem | undefined>({ length: input.images.length });
  let next = 0;

  const runOne = async (index: number): Promise<void> => {
    const imagePath = input.images[index]!;
    const identity = input.identities[index]!;
    const startedAt = input.now();
    let result: RecognizeResult;
    try {
      result = await input.recognizeImage({
        identity,
        imagePath,
        mode: input.mode,
        fields: input.fields,
        questions: input.questions,
        selection: input.selection,
        traceId: input.traceId,
        workingDirectory: input.workingDirectory,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      result = {
        status: "error",
        reason: "other",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    results[index] = {
      index,
      image: relativeDisplayPath(input.folder, imagePath),
      absolutePath: imagePath,
      status: result.status === "success" ? "success" : "error",
      durationMs: input.now() - startedAt,
      result,
    };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= input.images.length) return;
      if (input.signal?.aborted === true) {
        results[index] = abortedItem(index, input);
        continue;
      }
      await runOne(index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(input.maxConcurrency, input.images.length) }, () => worker()),
  );
  return results.map((item, index) => item ?? abortedItem(index, input));
}

function abortedItem(
  index: number,
  input: { images: readonly string[]; folder: string },
): RecognizeFinalItem {
  const imagePath = input.images[index]!;
  return {
    index,
    image: relativeDisplayPath(input.folder, imagePath),
    absolutePath: imagePath,
    status: "error",
    durationMs: 0,
    result: { status: "error", reason: "other", message: "aborted before dispatch" },
  };
}

/** 展示路径：folder 内相对路径，folder 外退回 basename（不泄露整条绝对路径到结果行）。 */
function relativeDisplayPath(folder: string, imagePath: string): string {
  const normalizedFolder = folder.endsWith("/") ? folder : `${folder}/`;
  return imagePath.startsWith(normalizedFolder)
    ? imagePath.slice(normalizedFolder.length)
    : imageBasename(imagePath);
}
