import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceWatchState,
  createInitialWatchState,
  createStreamWatchStateStore,
} from "../src/runtime/stream-monitor/watch-state.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("stream watch-state store", () => {
  it("save 后可恢复读取；文件为原子写（tmp+rename，无残留 tmp）", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zcode-stream-state-"));
    tempRoots.push(stateDir);
    const store = createStreamWatchStateStore({
      stateDir,
      monitorId: "stream-gate",
      streamId: "gate",
    });
    expect(await store.load()).toBeUndefined();

    const state = createInitialWatchState("stream-gate", "gate");
    advanceWatchState(state, { seq: 0, artifactUri: "zcode-artifact://a0", entryId: "stream-gate-000000" });
    await store.save(state);

    const reloaded = createStreamWatchStateStore({
      stateDir,
      monitorId: "stream-gate",
      streamId: "gate",
    });
    const restored = await reloaded.load();
    expect(restored?.lastProcessedSegmentSeq).toBe(0);
    expect(restored?.recentSegments).toHaveLength(1);
  });

  it("损坏的 state 文件 warn 后重置为 undefined（重跑安全）", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zcode-stream-state-bad-"));
    tempRoots.push(stateDir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(stateDir, "watch-state.json"), "{not json");
    const store = createStreamWatchStateStore({
      stateDir,
      monitorId: "stream-gate",
      streamId: "gate",
    });
    expect(await store.load()).toBeUndefined();
  });
});

describe("advanceWatchState", () => {
  it("推进游标并返回超出保留窗口的旧记录（供 artifact 清理）", () => {
    const state = createInitialWatchState("stream-gate", "gate");
    for (let seq = 0; seq < 12; seq += 1) {
      const dropped = advanceWatchState(state, {
        seq,
        artifactUri: `zcode-artifact://${seq}`,
        entryId: `stream-gate-${String(seq).padStart(6, "0")}`,
      });
      if (seq < 10) {
        // 保留窗口 10：前 10 次推进不挤出任何记录。
        expect(dropped).toHaveLength(0);
      } else {
        expect(dropped).toHaveLength(1);
        expect(dropped[0].seq).toBe(seq - 10);
      }
    }
    expect(state.lastProcessedSegmentSeq).toBe(11);
    // recentSegments 新记录在前（倒序修剪）。
    expect(state.recentSegments.map((record) => record.seq)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it("乱序推进只接受更大于游标的 seq", () => {
    const state = createInitialWatchState("stream-gate", "gate");
    advanceWatchState(state, { seq: 3, entryId: "stream-gate-000003" });
    const dropped = advanceWatchState(state, { seq: 2, entryId: "stream-gate-000002" });
    expect(state.lastProcessedSegmentSeq).toBe(3);
    expect(dropped).toHaveLength(0);
  });
});
