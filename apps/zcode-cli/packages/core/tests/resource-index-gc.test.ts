import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createWorkspaceResourceIndexPort } from "../../adapters/src/storage/workspace-resource-index.js";
import { createResourceIndexGCHelper } from "../src/runtime/helpers/resource-index/gc.js";
import type {
  WorkspaceResourceIndexEntry,
  WorkspaceResourceIndexPort,
} from "@zcode/contracts";

const WORKSPACE_A = "ws-gc-alpha";

let tmpDir: string;
let dbPath: string;
let port: WorkspaceResourceIndexPort;

function entry(overrides: Partial<WorkspaceResourceIndexEntry>): WorkspaceResourceIndexEntry {
  return {
    id: "img_default",
    workspaceIdentity: WORKSPACE_A,
    workspacePath: "/tmp/project-root",
    kind: "image",
    title: "image.png",
    filename: "image.png",
    sourceOrigin: "user_upload",
    addedAt: 1,
    updatedAt: 1,
    variants: [
      {
        kind: "original",
        mime: "image/png",
        bytes: 1024,
        sha256: "abc",
        artifactUri: "zcode-artifact://img_default",
      },
    ],
    references: 1,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wsr-gc-"));
  dbPath = join(tmpDir, "gc.db");
  port = createWorkspaceResourceIndexPort({ dbPath });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("workspace resource index GC helper", () => {
  it("register / unregister 维护 references；session 注册的 entry 引用计数变化", async () => {
    await port.upsert(entry({ id: "img_001" }));
    await port.upsert(entry({ id: "img_002" }));
    const gc = createResourceIndexGCHelper({ port, workspaceKey: WORKSPACE_A });
    await gc.registerSessionReference("session-1", ["img_001", "img_002"]);
    expect((await port.getById(WORKSPACE_A, "img_001"))?.references).toBe(2);
    expect((await port.getById(WORKSPACE_A, "img_002"))?.references).toBe(2);
    await gc.unregisterSessionReference("session-1", ["img_001"]);
    expect((await port.getById(WORKSPACE_A, "img_001"))?.references).toBe(1);
    expect((await port.getById(WORKSPACE_A, "img_002"))?.references).toBe(2);
  });

  it("closeSession 释放该 session 注册过的全部引用", async () => {
    await port.upsert(entry({ id: "img_a" }));
    await port.upsert(entry({ id: "img_b" }));
    const gc = createResourceIndexGCHelper({ port, workspaceKey: WORKSPACE_A });
    await gc.registerSessionReference("session-x", ["img_a", "img_b"]);
    expect((await port.getById(WORKSPACE_A, "img_a"))?.references).toBe(2);
    await gc.closeSession("session-x");
    expect((await port.getById(WORKSPACE_A, "img_a"))?.references).toBe(1);
    expect((await port.getById(WORKSPACE_A, "img_b"))?.references).toBe(1);
  });

  it("register 同 session 同 id 重复调用仅累加一次", async () => {
    await port.upsert(entry({ id: "img_dup" }));
    const gc = createResourceIndexGCHelper({ port, workspaceKey: WORKSPACE_A });
    await gc.registerSessionReference("session-z", ["img_dup"]);
    await gc.registerSessionReference("session-z", ["img_dup"]);
    await gc.registerSessionReference("session-z", ["img_dup"]);
    expect((await port.getById(WORKSPACE_A, "img_dup"))?.references).toBe(2);
  });

  it("unregister 未注册过的 id 不抛错，引用不变", async () => {
    await port.upsert(entry({ id: "img_unreg" }));
    const gc = createResourceIndexGCHelper({ port, workspaceKey: WORKSPACE_A });
    await gc.unregisterSessionReference("session-y", ["img_unreg"]);
    expect((await port.getById(WORKSPACE_A, "img_unreg"))?.references).toBe(1);
  });

  it("tick() 删除 ref_count == 0 entries；保留 > 0 entries", async () => {
    await port.upsert(entry({ id: "img_orphan" }));
    await port.upsert(entry({ id: "img_keep" }));
    await port.incrementReferences({ workspaceKey: WORKSPACE_A, ids: ["img_keep"], delta: 1 });
    // 把 img_orphan 减到 0，期望被 GC；img_keep 仍 > 0，保留。
    await port.incrementReferences({ workspaceKey: WORKSPACE_A, ids: ["img_orphan"], delta: -1 });
    const gc = createResourceIndexGCHelper({ port, workspaceKey: WORKSPACE_A });
    const result = await gc.tick();
    expect(result.removed).toContain("img_orphan");
    expect(result.removed).not.toContain("img_keep");
    expect(await port.getById(WORKSPACE_A, "img_orphan")).toBeUndefined();
    expect(await port.getById(WORKSPACE_A, "img_keep")).toBeDefined();
  });

  it("closeSession 重复调用安全幂等", async () => {
    await port.upsert(entry({ id: "img_idem" }));
    const gc = createResourceIndexGCHelper({ port, workspaceKey: WORKSPACE_A });
    await gc.registerSessionReference("session-idem", ["img_idem"]);
    await gc.closeSession("session-idem");
    await gc.closeSession("session-idem");
    expect((await port.getById(WORKSPACE_A, "img_idem"))?.references).toBe(1);
  });
});