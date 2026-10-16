import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STREAM_ALERT_RETENTION_DAYS,
  createStreamAlertStore,
} from "../src/runtime/stream-monitor/alert-store.js";
import {
  buildAnalysisPrompt,
  parseStreamAnalysisResponse,
} from "../src/runtime/stream-monitor/alert-judge.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore(streamId = "gate") {
  const dir = await mkdtemp(join(tmpdir(), "zcode-stream-alert-"));
  tempRoots.push(dir);
  const clockState = { now: 1_000 };
  const store = createStreamAlertStore({
    alertStoreDir: dir,
    streamId,
    clock: () => clockState.now,
  });
  return {
    dir,
    store,
    tick: () => (clockState.now += 1),
    setNow: (value: number) => (clockState.now = value),
  };
}

describe("stream alert judge", () => {
  it("合法判定通过", () => {
    const judgement = parseStreamAnalysisResponse(
      '{"status":"anomaly","severity":"high","reason":"画面出现人员翻越"}',
    );
    expect(judgement.ok).toBe(true);
    if (judgement.ok) {
      expect(judgement.verdict.status).toBe("anomaly");
      expect(judgement.verdict.severity).toBe("high");
    }
  });

  it("幻觉输出（缺字段 / 多余字段 / 非法 JSON）一律拒收", () => {
    const cases = [
      "不是 JSON 的回答",
      '{"status":"weird","reason":"x"}',
      '{"status":"anomaly","reason":"x","extra":1}',
      '{"reason":"缺少 status"}',
    ];
    for (const response of cases) {
      const judgement = parseStreamAnalysisResponse(response);
      expect(judgement.ok).toBe(false);
    }
  });

  it("提取混在文本中的 JSON 块", () => {
    const judgement = parseStreamAnalysisResponse(
      '好的，判定如下：{"status":"normal","reason":"画面正常无异常"} 以上。',
    );
    expect(judgement.ok).toBe(true);
  });

  it("prompt 只含 stream 标识与判定指令，不含 URL / 凭据", () => {
    const titled = buildAnalysisPrompt({ streamId: "gate", streamTitle: "大门", segmentSeq: 7 });
    expect(titled).toContain("大门");
    expect(titled).not.toMatch(/rtsp:\/\//u);
    expect(titled).not.toContain("password");
    const untitled = buildAnalysisPrompt({ streamId: "gate", segmentSeq: 7 });
    expect(untitled).toContain("gate");
  });
});

describe("stream alert store", () => {
  it("append 落盘 JSONL；analysis 行按 segmentSeq 去重", async () => {
    const { dir, store, tick } = await makeStore();
    const first = await store.append({
      kind: "analysis",
      status: "anomaly",
      segmentSeq: 3,
      severity: "high",
      reason: "人员入侵",
    });
    expect(first.deduplicated).toBe(false);
    tick();
    const again = await store.append({
      kind: "analysis",
      status: "anomaly",
      segmentSeq: 3,
      severity: "high",
      reason: "人员入侵",
    });
    expect(again.deduplicated).toBe(true);
    // 去重命中不重复写文件。
    const content = await readFile(join(dir, "gate.jsonl"), "utf-8");
    expect(content.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(1);

    // 新 store 实例从文件恢复去重键（崩溃重启幂等）。
    const reopened = createStreamAlertStore({
      alertStoreDir: dir,
      streamId: "gate",
      clock: () => 0,
    });
    const replay = await reopened.append({
      kind: "analysis",
      status: "anomaly",
      segmentSeq: 3,
      reason: "人员入侵",
    });
    expect(replay.deduplicated).toBe(true);
  });

  it("reason / summary 中的 URL 凭据写入前被脱敏", async () => {
    const { dir, store } = await makeStore();
    await store.append({
      kind: "lifecycle",
      status: "stream_down",
      reason: "connect failed: rtsp://user:secret@cam.local/live",
    });
    const content = await readFile(join(dir, "gate.jsonl"), "utf-8");
    expect(content).not.toContain("secret");
    expect(content).toContain("rtsp://cam.local/live");
  });

  it("query 支持 since / until / status / limit", async () => {
    const { store, tick } = await makeStore();
    tick();
    await store.append({ kind: "analysis", status: "normal", segmentSeq: 1 });
    tick();
    await store.append({ kind: "analysis", status: "anomaly", segmentSeq: 2, severity: "low" });
    tick();
    await store.append({ kind: "lifecycle", status: "stopped" });

    const all = await store.query({});
    expect(all).toHaveLength(3);
    expect((await store.query({ status: "anomaly" })).map((row) => row.segmentSeq)).toEqual([2]);
    expect((await store.query({ since: 1002, until: 1002 }))).toHaveLength(1);
    expect((await store.query({ limit: 1 }))).toHaveLength(1);
  });

  it("pruneExpired 清理超保留期行并保留近 30 天", async () => {
    const { dir, store, setNow } = await makeStore();
    // 旧时钟 store 写入一条过期行（ts=1000）。
    const oldStore = createStreamAlertStore({
      alertStoreDir: dir,
      streamId: "gate",
      clock: () => 1_000,
    });
    await oldStore.append({ kind: "analysis", status: "normal", segmentSeq: 0 });

    // 主时钟推进到旧行刚好过期、新行仍在保留期内（now - 30d > 1000）。
    const horizon = setNow(1_000 + (STREAM_ALERT_RETENTION_DAYS + 1) * 86_400_000);
    await store.append({ kind: "lifecycle", status: "started" });

    const removed = await store.pruneExpired(horizon);
    expect(removed).toBe(1);
    const remaining = await store.query({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe("started");
  });
});
