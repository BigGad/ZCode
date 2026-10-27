import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCompletedOutput } from "@zcode/contracts";
import {
  dispatchRecognizeImage,
  type RecognizeImageDispatch,
  type RecognizeRuntime,
} from "../src/recognize-runtime.js";
import { judgeRecognizeGrounding, RECOGNIZE_UNGROUNDED_MESSAGE } from "../src/recognize-grounding.js";

/**
 * 接地门回归测试（spec §5.1「接地不变量」）。
 *
 * 背景（运行时证据）：`image-recognizer` 的图**不在**模型请求里，只在模型自己调 `Read`
 * 时才到达。模型跳过 `Read` 直接作答时，它从未见过这张图，却能吐出一段合法的 JSON
 * ——实测（律小虾 2026-10-24 22:04 跑批，76 页 / 157 个子代理）有 22 个子代理 0 次工具
 * 调用，其中 21 页的编造正文被当成成功结果收进页卡（内容是 Vue.js 文档、虚构访谈节目等）。
 *
 * 因此：**0 次工具调用的正文一律不采纳**，先强制读图重试一次，仍未接地才报 unreadable。
 */

/** 编造的正文：看起来完全合法，只看内容绝对看不出问题。 */
const FABRICATED = JSON.stringify({
  status: "success",
  description: "Vue.js 是一套渐进式 JavaScript 框架，核心思想是组件化与响应式数据绑定……",
});

const REAL_TEXT = JSON.stringify({
  status: "success",
  description: "第 7 页：民事调解协议书，双方就房屋继承争议达成一致。",
});

function completedOutput(text: string, totalToolUseCount: number): AgentCompletedOutput {
  return {
    status: "completed",
    agentId: "agent_test",
    agentType: "image-recognizer",
    description: "Recognize image 1",
    prompt: "prompt",
    content: [{ type: "text", text }],
    totalToolUseCount,
    totalDurationMs: 10,
  };
}

interface FakeRuntime {
  runtime: RecognizeRuntime;
  prompts: string[];
}

/** 假 runtime：按序吐出预置的子代理输出；多派一次就直接抛错（说明重试次数失控）。 */
function fakeRuntime(outputs: readonly AgentCompletedOutput[]): FakeRuntime {
  const prompts: string[] = [];
  const state = { calls: 0 };
  const runtime = {
    app: {
      runtime: {
        runSubagent: async (request: { prompt: string }) => {
          prompts.push(request.prompt);
          const output = outputs[state.calls];
          state.calls += 1;
          if (output === undefined) {
            throw new Error("runSubagent called more times than expected");
          }
          return output;
        },
      },
    },
  } as unknown as RecognizeRuntime;
  return { runtime, prompts };
}

const DISPATCH: RecognizeImageDispatch = {
  identity: {
    index: 0,
    subagentId: "image-1",
    shortId: "a3f",
    runtimeSessionId: "sess_recognize_0",
    parentToolCallId: "recognize-0",
  },
  imagePath: "/tmp/page-07.png",
  mode: "description",
  fields: [],
  questions: [],
  selection: { providerId: "test-provider", modelId: "vision-1" },
  traceId: "trace-1",
  workingDirectory: "/tmp",
};

test("judgeRecognizeGrounding：0 次工具调用即未接地", () => {
  assert.equal(judgeRecognizeGrounding({ totalToolUseCount: 0 }).grounded, false);
  assert.equal(judgeRecognizeGrounding({ totalToolUseCount: 1 }).grounded, true);
  assert.equal(judgeRecognizeGrounding({ totalToolUseCount: 7 }).grounded, true);
  // 计数异常（NaN）按未接地处理：宁可报缺口，不放行。
  assert.equal(judgeRecognizeGrounding({ totalToolUseCount: Number.NaN }).grounded, false);
});

test("接地的子代理直接采纳正文，只派发一次", async () => {
  const fake = fakeRuntime([completedOutput(REAL_TEXT, 1)]);
  const result = await dispatchRecognizeImage(fake.runtime, DISPATCH);

  assert.equal(result.status, "success");
  assert.equal(result.status === "success" ? result.description : undefined, "第 7 页：民事调解协议书，双方就房屋继承争议达成一致。");
  assert.equal(fake.prompts.length, 1);
  // 第一次派发就要带读图指令。
  assert.match(fake.prompts[0]!, /Read the image first/u);
});

test("未接地：第一次正文丢弃，用强制读图指令重试一次并采纳重试结果", async () => {
  const fake = fakeRuntime([
    completedOutput(FABRICATED, 0),
    completedOutput(REAL_TEXT, 1),
  ]);
  const result = await dispatchRecognizeImage(fake.runtime, DISPATCH);

  assert.equal(result.status, "success");
  assert.equal(result.status === "success" ? result.description : undefined, "第 7 页：民事调解协议书，双方就房屋继承争议达成一致。");
  // 两次派发：第一次未接地，第二次带强制读图指令。
  assert.equal(fake.prompts.length, 2);
  assert.match(fake.prompts[1]!, /previous attempt answered WITHOUT reading the image/u);
  assert.match(fake.prompts[1]!, /\/tmp\/page-07\.png/u);
});

test("两次都未接地：报 unreadable，编造的正文不出现", async () => {
  const fake = fakeRuntime([completedOutput(FABRICATED, 0), completedOutput(FABRICATED, 0)]);
  const result = await dispatchRecognizeImage(fake.runtime, DISPATCH);

  assert.equal(result.status, "error");
  assert.equal(result.status === "error" ? result.reason : undefined, "unreadable");
  assert.equal(result.status === "error" ? result.message : undefined, RECOGNIZE_UNGROUNDED_MESSAGE);
  // 编造内容一个字都不能漏出去。
  assert.doesNotMatch(JSON.stringify(result), /Vue\.js/u);
  // 只重试一次，不做无限重试。
  assert.equal(fake.prompts.length, 2);
});

test("子代理未完成（后台化/失败）时按 other 失败，不做读图重试", async () => {
  const prompts: string[] = [];
  const runtime = {
    app: {
      runtime: {
        runSubagent: async (request: { prompt: string }) => {
          prompts.push(request.prompt);
          return { status: "async_launched", isAsync: true };
        },
      },
    },
  } as unknown as RecognizeRuntime;
  const result = await dispatchRecognizeImage(runtime, DISPATCH);

  assert.equal(result.status, "error");
  assert.equal(result.status === "error" ? result.reason : undefined, "other");
  assert.equal(prompts.length, 1);
});
