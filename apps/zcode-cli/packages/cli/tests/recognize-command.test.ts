import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";
import { runRecognizeCommand, type RecognizeCommandDependencies } from "../src/recognize-command.js";
import type { ImageModelCandidate } from "../src/recognize-model.js";
import { createRecognizeProgressReporter } from "../src/recognize-progress.js";
import type { RecognizeImageDispatch } from "../src/recognize-runtime.js";
import { buildRecognizeDispatchPrompt, parseRecognizeResult } from "../src/recognize-schema.js";
import { walkImageFolder } from "../src/recognize-walker.js";

type CapturedWriteStream = NodeJS.WriteStream & { output(): string };

function stream(): CapturedWriteStream {
  let output = "";
  const writable = {
    write: (chunk: string) => {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return Object.assign(writable, { output: () => output });
}

function context(): { ctx: RunContext; stdout: CapturedWriteStream; stderr: CapturedWriteStream } {
  const stdout = stream();
  const stderr = stream();
  return { ctx: { stdout, stderr } as unknown as RunContext, stdout, stderr };
}

const globalOptions = {
  force: false,
  json: false,
  noColor: true,
  verbose: false,
};

const IMAGE_CANDIDATE: ImageModelCandidate = {
  providerId: "test-provider",
  modelId: "vision-1",
  supportsImage: true,
};

/** 默认依赖：跳过 bootstrap 与真实模型，只保留命令自身的编排行为。 */
function deps(overrides: Partial<RecognizeCommandDependencies> = {}): RecognizeCommandDependencies {
  return {
    modelResolution: { candidates: [IMAGE_CANDIDATE] },
    recognizeImage: async () => ({ status: "success", description: "ok" }),
    ...overrides,
  };
}

async function fixtureFolder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-recognize-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

test("walker 收集图片、过滤非图片并按大小写不敏感扩展名计数", async () => {
  const dir = await fixtureFolder({
    "01.jpg": "a",
    "02.PNG": "b",
    "notes.txt": "c",
    "sub/03.png": "d",
  });
  try {
    const flat = await walkImageFolder({ folder: dir });
    assert.equal(flat.images.length, 2);
    assert.deepEqual(flat.byExtension, { jpg: 1, png: 1 });

    const recursive = await walkImageFolder({ folder: dir, recursive: true });
    assert.equal(recursive.images.length, 3);
    assert.deepEqual(recursive.byExtension, { jpg: 1, png: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildRecognizeDispatchPrompt 三种模式都把 schema 文本嵌进 prompt", () => {
  const description = buildRecognizeDispatchPrompt({ imagePath: "/tmp/a.png", mode: "description" });
  assert.match(description.prompt, /jsonSchema:/u);
  assert.match(description.prompt, /"description"/u);

  const qa = buildRecognizeDispatchPrompt({
    imagePath: "/tmp/a.png",
    mode: "qa",
    questions: ["What colour?"],
  });
  assert.match(qa.prompt, /What colour\?/u);

  const structured = buildRecognizeDispatchPrompt({
    imagePath: "/tmp/a.png",
    mode: "structured",
    fields: ["title"],
  });
  assert.match(structured.prompt, /title/u);
});

test("parseRecognizeResult 接受合法输出、把非法输出归类为 schema_mismatch", () => {
  const ok = parseRecognizeResult({
    rawText: '```json\n{"status":"success","description":"a cat"}\n```',
    mode: "description",
  });
  assert.deepEqual(ok, { status: "success", description: "a cat" });

  const mismatch = parseRecognizeResult({ rawText: "not json at all", mode: "description" });
  assert.equal(mismatch.status, "error");
  assert.equal(mismatch.status === "error" ? mismatch.reason : undefined, "schema_mismatch");

  const missingField = parseRecognizeResult({
    rawText: '{"status":"success","fields":{"other":1}}',
    mode: "structured",
    fields: ["title"],
  });
  assert.equal(missingField.status, "error");

  const empty = parseRecognizeResult({ rawText: "   ", mode: "description" });
  assert.equal(empty.status === "error" ? empty.reason : undefined, "no_text");
});

test("progress reporter 按 parentToolCallId 归并父子事件、按 runner 铸的子会话 id 归并流式正文", () => {
  const lines: { stage: string; preview?: string; outcome?: string }[] = [];
  let clock = 0;
  const reporter = createRecognizeProgressReporter({
    identities: [
      {
        index: 0,
        subagentId: "image-1",
        shortId: "aaa",
        runtimeSessionId: "sess_recognize_a_0",
        parentToolCallId: "recognize-a-0",
      },
    ],
    now: () => clock,
    emit: (line) => lines.push({ stage: line.stage, ...(line.preview === undefined ? {} : { preview: line.preview }), ...(line.outcome === undefined ? {} : { outcome: line.outcome }) }),
  });

  // 回归：子 runtime 的流式事件 sessionId 是 runner 另铸的 `sess_subagent_*`，不是派发时
  // 传入的 `sess_recognize_*`。归并键必须从 `SubagentSpawned` 载荷的 `childSessionId` 学到。
  const childSessionId = "sess_subagent_agent_40936a39";
  reporter(
    event(SessionEventType.SubagentSpawned, "sess_recognize_a_0", {
      parentToolCallId: "recognize-a-0",
      childSessionId,
    }),
  );
  // 同一毫秒内的多条 delta 只放一条 message（250ms 节流）。
  for (const delta of ["A night ", "market ", "with lanterns"]) {
    reporter(
      event(SessionEventType.ModelStreaming, childSessionId, {
        kind: "text_delta",
        delta,
      }),
    );
  }
  clock = 500;
  reporter(
    event(SessionEventType.ModelStreaming, childSessionId, {
      kind: "text_delta",
      delta: " everywhere",
    }),
  );
  reporter(
    event(SessionEventType.SubagentStopped, "sess_recognize_a_0", {
      parentToolCallId: "recognize-a-0",
      childSessionId,
      status: "completed",
      totalDurationMs: 1200,
    }),
  );

  assert.deepEqual(
    lines.map((line) => line.stage),
    ["started", "message", "message", "stopped"],
  );
  assert.equal(lines[0]!.preview, undefined);
  // message 行是「此刻已累积的正文」的快照：第一条 delta 立刻放行，节流窗口内的后续 delta
  // 只累积不输出，窗口过后再放行一次。
  assert.equal(lines[1]!.preview, "A night");
  assert.equal(lines[2]!.preview, "A night market with lanterns everywhere");
  assert.equal(lines[3]!.outcome, "ok");

  // stopped 之后子会话 id 出栈：迟到的同 id 事件不再归并到已结束的子代理。
  const after = lines.length;
  reporter(
    event(SessionEventType.ModelStreaming, childSessionId, {
      kind: "text_delta",
      delta: " late",
    }),
  );
  assert.equal(lines.length, after);
});

test("recognize --json 输出 plan/results/summary，全部成功 exit 0", async () => {
  const dir = await fixtureFolder({ "01.jpg": "a", "02.png": "b" });
  const { ctx, stdout, stderr } = context();
  try {
    const code = await runRecognizeCommand(
      ctx,
      { ...globalOptions, json: true },
      { folder: dir },
      deps({
        recognizeImage: async (dispatch: RecognizeImageDispatch) => ({
          status: "success",
          description: `seen ${dispatch.identity.subagentId}`,
        }),
      }),
    );
    assert.equal(code, 0);
    const payload = JSON.parse(stdout.output()) as {
      plan: { totalImages: number; model: string; schema: string };
      results: unknown[];
      summary: { total: number; succeeded: number; failed: number };
    };
    assert.equal(payload.plan.totalImages, 2);
    assert.equal(payload.plan.model, "test-provider/vision-1");
    assert.equal(payload.plan.schema, "description");
    assert.equal(payload.results.length, 2);
    assert.deepEqual(
      { total: payload.summary.total, succeeded: payload.summary.succeeded, failed: payload.summary.failed },
      { total: 2, succeeded: 2, failed: 0 },
    );
    // json 模式的结果只在末尾一次性打印，plan 不单独出现在 stdout。
    assert.equal(stderr.output(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("缺目录 exit 2，目录内无支持图片 exit 2", async () => {
  const { ctx, stderr } = context();
  const missing = await runRecognizeCommand(
    ctx,
    globalOptions,
    { folder: join(tmpdir(), "zcode-recognize-does-not-exist") },
    deps(),
  );
  assert.equal(missing, 2);

  const dir = await fixtureFolder({ "notes.txt": "c" });
  try {
    const { ctx: ctx2 } = context();
    const empty = await runRecognizeCommand(ctx2, globalOptions, { folder: dir }, deps());
    assert.equal(empty, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(stderr.output(), /Cannot read folder/u);
});

test("scope 错误 exit 1：structured 缺 --fields、qa 缺 --questions、fields 用错模式", async () => {
  const dir = await fixtureFolder({ "01.jpg": "a" });
  try {
    for (const cmdOptions of [
      { folder: dir, schema: "structured" },
      { folder: dir, schema: "qa" },
      { folder: dir, schema: "description", fields: ["title"] },
      { folder: dir, schema: "unknown" },
    ]) {
      const { ctx, stderr } = context();
      assert.equal(await runRecognizeCommand(ctx, globalOptions, cmdOptions, deps()), 1);
      assert.notEqual(stderr.output(), "");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("部分失败 exit 0、全部失败 exit 1，且单张失败不打断兄弟", async () => {
  const dir = await fixtureFolder({ "01.jpg": "a", "02.jpg": "b", "03.jpg": "c" });
  try {
    const partial = context();
    const partialCode = await runRecognizeCommand(
      partial.ctx,
      globalOptions,
      { folder: dir },
      deps({
        recognizeImage: async (dispatch) =>
          dispatch.identity.index === 0
            ? { status: "error", reason: "schema_mismatch", message: "nope" }
            : { status: "success", description: "ok" },
      }),
    );
    assert.equal(partialCode, 0);
    assert.match(partial.stdout.output(), /FAIL/u);

    const total = context();
    const totalCode = await runRecognizeCommand(
      total.ctx,
      globalOptions,
      { folder: dir },
      deps({
        recognizeImage: async () => ({ status: "error", reason: "unreadable", message: "no" }),
      }),
    );
    assert.equal(totalCode, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--max-concurrency 生效，且结果顺序与 walker 顺序一致", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => [`0${index}.jpg`, "x"]),
  );
  const dir = await fixtureFolder(files);
  try {
    let inFlight = 0;
    let peak = 0;
    const { ctx, stdout } = context();
    const code = await runRecognizeCommand(
      ctx,
      globalOptions,
      { folder: dir, maxConcurrency: "2" },
      deps({
        recognizeImage: async (dispatch) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { status: "success", description: dispatch.identity.subagentId };
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(peak, 2);

    const order = [...stdout.output().matchAll(/\[(\d+)\/\d+\] (\S+)/gu)].map((match) => match[2]);
    assert.deepEqual(order, [...order].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stream-json 依次输出 plan → result 两段 NDJSON，stderr 不写进度", async () => {
  const dir = await fixtureFolder({ "01.jpg": "a" });
  try {
    const { ctx, stdout, stderr } = context();
    const code = await runRecognizeCommand(
      ctx,
      { ...globalOptions, outputFormat: "stream-json" },
      { folder: dir },
      deps(),
    );
    assert.equal(code, 0);
    const lines = stdout.output().trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(
      lines.map((line) => line.type),
      ["plan", "result"],
    );
    assert.equal(stderr.output(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--image-glob 过滤、--recursive 控制子目录、--model 覆盖默认选择", async () => {
  const dir = await fixtureFolder({ "keep-01.jpg": "a", "drop-01.jpg": "b", "sub/keep-02.png": "c" });
  try {
    const flat = context();
    await runRecognizeCommand(
      flat.ctx,
      { ...globalOptions, json: true },
      { folder: dir, imageGlob: "keep-*.jpg" },
      deps(),
    );
    assert.equal(
      (JSON.parse(flat.stdout.output()) as { plan: { totalImages: number } }).plan.totalImages,
      1,
    );

    const recursive = context();
    await runRecognizeCommand(
      recursive.ctx,
      { ...globalOptions, json: true },
      { folder: dir, recursive: true },
      deps(),
    );
    assert.equal(
      (JSON.parse(recursive.stdout.output()) as { plan: { totalImages: number } }).plan.totalImages,
      3,
    );

    const explicit = context();
    await runRecognizeCommand(
      explicit.ctx,
      { ...globalOptions, json: true },
      { folder: dir, model: "other-provider/vision-9$enabled" },
      deps(),
    );
    assert.equal(
      (JSON.parse(explicit.stdout.output()) as { plan: { model: string } }).plan.model,
      "other-provider/vision-9",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("没有图像模型时 exit 1 并给出可操作提示", async () => {
  const dir = await fixtureFolder({ "01.jpg": "a" });
  try {
    const { ctx, stderr } = context();
    const code = await runRecognizeCommand(
      ctx,
      globalOptions,
      { folder: dir },
      deps({ modelResolution: { candidates: [] } }),
    );
    assert.equal(code, 1);
    assert.match(stderr.output(), /--model/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("能力模型选择优先于默认选择，--model 仍最高", async () => {
  const dir = await fixtureFolder({ "01.jpg": "a" });
  const capabilityCandidate: ImageModelCandidate = {
    providerId: "capability-provider",
    modelId: "capability-vision",
    supportsImage: true,
  };
  try {
    const capability = context();
    await runRecognizeCommand(
      capability.ctx,
      { ...globalOptions, json: true },
      { folder: dir },
      deps({
        modelResolution: {
          candidates: [IMAGE_CANDIDATE, capabilityCandidate],
          configuredCapability: {
            providerId: capabilityCandidate.providerId,
            modelId: capabilityCandidate.modelId,
          },
          configuredDefault: { providerId: IMAGE_CANDIDATE.providerId, modelId: IMAGE_CANDIDATE.modelId },
        },
      }),
    );
    assert.equal(
      (JSON.parse(capability.stdout.output()) as { plan: { model: string } }).plan.model,
      "capability-provider/capability-vision",
    );

    // 能力模型不支持图片（或不在 registry 候选里）时不能让识别跑偏，退回默认选择。
    const fallback = context();
    await runRecognizeCommand(
      fallback.ctx,
      { ...globalOptions, json: true },
      { folder: dir },
      deps({
        modelResolution: {
          candidates: [IMAGE_CANDIDATE],
          configuredCapability: { providerId: "capability-provider", modelId: "capability-vision" },
          configuredDefault: { providerId: IMAGE_CANDIDATE.providerId, modelId: IMAGE_CANDIDATE.modelId },
        },
      }),
    );
    assert.equal(
      (JSON.parse(fallback.stdout.output()) as { plan: { model: string } }).plan.model,
      "test-provider/vision-1",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function event(
  type: SessionEvent["type"],
  sessionId: string,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: "evt",
    sessionId,
    type,
    timestamp: new Date(0),
    traceId: "trace",
    sequenceNumber: 0,
    payload,
  } as unknown as SessionEvent;
}
