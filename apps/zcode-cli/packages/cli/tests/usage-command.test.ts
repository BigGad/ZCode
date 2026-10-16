import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { RunContext } from "@zcode/shared-types";
import { runUsageCommand } from "../src/usage-command.js";

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

interface UsageFixture {
  dbPath: string;
  dispose: () => Promise<void>;
  openStore: () => ReturnType<typeof createSqliteSessionStore>;
  sessionId: string;
}

async function createUsageFixture(): Promise<UsageFixture> {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-usage-command-"));
  const dbPath = join(tempRoot, "session.sqlite");
  const store = createSqliteSessionStore({ dbPath });
  const sessionId = "sess_usage_command_fixture" as Parameters<
    typeof store.createSession
  >[0]["id"];
  await store.createSession({
    id: sessionId,
    projectID: "proj_usage_command" as never,
    slug: "usage-command",
    directory: tempRoot,
    title: "usage command fixture",
    version: "0.1.0",
  });
  await store.recordModelUsage({
    agent: "explore",
    id: "usage_command_model",
    inputTokens: 50,
    logicalRequestId: "logical-command",
    modelId: "model-x",
    outputTokens: 5,
    providerId: "provider-x",
    querySource: "subagent",
    sessionID: sessionId,
    startedAt: Date.now(),
    status: "completed",
  });
  await store.saveMessage({
    id: "msg_usage_command_user" as never,
    sessionID: sessionId,
    role: "user" as never,
    time: { created: Date.now() },
    // 其余字段由 saveMessage 的类型面决定；测试只关心文本 part 往返。
    ...({ text: "hello" } as never),
  } as never);
  await store.close();
  return {
    dbPath,
    dispose: () => rm(tempRoot, { force: true, recursive: true }),
    openStore: () => createSqliteSessionStore({ dbPath }),
    sessionId,
  };
}

test("usage command summarizes and exports records from the session store", async () => {
  const fixture = await createUsageFixture();
  try {
    const summary = context();
    await runUsageCommand(summary.ctx, {}, {}, {
      createSessionStore: () => fixture.openStore(),
    });
    assert.ok(summary.stdout.output().includes("model-x"));
    assert.ok(summary.stdout.output().includes("explore (subagent)"));
    assert.ok(summary.stdout.output().includes("retention: usage rows are pruned after 30 days"));

    const json = context();
    await runUsageCommand(json.ctx, { json: true }, { json: true, tools: true }, {
      createSessionStore: () => fixture.openStore(),
    });
    const lines = json.stdout
      .output()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines[0]?.kind, "meta");
    assert.equal(lines[0]?.truncated, false);
    const modelRow = lines.find((line) => line.kind === "model_request");
    assert.equal(modelRow?.modelId, "model-x");
    assert.equal(modelRow?.querySource, "subagent");
    assert.equal(modelRow?.sessionID, fixture.sessionId);

    const sessionJson = context();
    await runUsageCommand(
      sessionJson.ctx,
      { json: true },
      { json: true, session: fixture.sessionId },
      { createSessionStore: () => fixture.openStore() },
    );
    const sessionLines = sessionJson.stdout
      .output()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(sessionLines[0]?.kind, "session_meta");
    assert.ok(sessionLines.some((line) => line.kind === "message"));

    const unknownSession = context();
    const exitCode = await runUsageCommand(
      unknownSession.ctx,
      {},
      { session: "sess_missing" as never },
      { createSessionStore: () => fixture.openStore() },
    );
    assert.equal(exitCode, 1);
    assert.ok(unknownSession.stderr.output().includes("session not found"));
  } finally {
    await fixture.dispose();
  }
});
