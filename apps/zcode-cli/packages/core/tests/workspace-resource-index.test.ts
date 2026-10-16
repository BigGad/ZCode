import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createWorkspaceResourceIndexPort } from "../../adapters/src/storage/workspace-resource-index.js";
import type {
  WorkspaceResourceIndexEntry,
  WorkspaceResourceIndexPort,
  WorkspaceResourceVariant,
} from "@zcode/contracts";

const WORKSPACE_A = "ws-alpha";
const WORKSPACE_B = "ws-beta";
const WORKSPACE_PATH = "/tmp/project-root";

let tmpDir: string;
let dbPathA: string;
let dbPathB: string;
let portA: WorkspaceResourceIndexPort;
let portB: WorkspaceResourceIndexPort;

function entry(overrides: Partial<WorkspaceResourceIndexEntry>): WorkspaceResourceIndexEntry {
  const baseVariants: WorkspaceResourceVariant[] = [
    {
      kind: "original",
      mime: "image/png",
      bytes: 1024,
      sha256: "abc123",
      artifactUri: "zcode-artifact://placeholder",
    },
  ];
  const base: WorkspaceResourceIndexEntry = {
    id: "img_default",
    workspaceIdentity: WORKSPACE_A,
    workspacePath: WORKSPACE_PATH,
    kind: "image",
    title: "image.png",
    filename: "image.png",
    sourceOrigin: "user_upload",
    addedAt: 1,
    updatedAt: 1,
    variants: baseVariants,
    references: 1,
  };
  const merged: WorkspaceResourceIndexEntry = {
    ...base,
    ...overrides,
    variants: overrides.variants ?? baseVariants,
  };
  // 让 artifactUri 跟随 id 走，避免每个测试硬编码同一 URI。
  if (merged.variants[0]) {
    merged.variants = merged.variants.map((v, idx) =>
      idx === 0 && v.kind === "original" && v.artifactUri === "zcode-artifact://placeholder"
        ? { ...v, artifactUri: `zcode-artifact://${merged.id}` }
        : v,
    );
  }
  return merged;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wsr-test-"));
  dbPathA = join(tmpDir, "alpha.db");
  dbPathB = join(tmpDir, "beta.db");
  portA = createWorkspaceResourceIndexPort({ dbPath: dbPathA });
  portB = createWorkspaceResourceIndexPort({ dbPath: dbPathB });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("workspace resource index port", () => {
  it("upsert 与 getById 往返一致", async () => {
    const stored = await portA.upsert(entry({ id: "img_001" }));
    expect(stored.id).toBe("img_001");
    const fetched = await portA.getById(WORKSPACE_A, "img_001");
    expect(fetched).toBeDefined();
    expect(fetched?.variants).toHaveLength(1);
    expect(fetched?.variants[0]?.kind).toBe("original");
    expect(fetched?.variants[0]?.artifactUri).toBe("zcode-artifact://img_001");
  });

  it("同一 id 二次 upsert：保留 addedAt 与 references，更新 variants", async () => {
    await portA.upsert(entry({ id: "img_002", addedAt: 100, references: 5 }));
    await portA.incrementReferences({ workspaceKey: WORKSPACE_A, ids: ["img_002"], delta: 2 });
    const newVariant: WorkspaceResourceVariant = {
      kind: "transcript",
      mime: "text/plain",
      bytes: 256,
      sha256: "txhash",
    };
    await portA.upsert(
      entry({
        id: "img_002",
        addedAt: 200,
        updatedAt: 200,
        references: 7,
        variants: [newVariant],
      }),
    );
    const fetched = await portA.getById(WORKSPACE_A, "img_002");
    expect(fetched?.addedAt).toBe(100);
    expect(fetched?.references).toBe(7);
    expect(fetched?.variants.map((v) => v.kind)).toEqual(["transcript"]);
  });

  it("addVariant 追加 variant 变体并更新 updatedAt", async () => {
    await portA.upsert(entry({ id: "audio_001", kind: "audio" }));
    await portA.addVariant({
      workspaceKey: WORKSPACE_A,
      id: "audio_001",
      variant: { kind: "transcript", mime: "text/plain", bytes: 4096, sha256: "tx001" },
    });
    const fetched = await portA.getById(WORKSPACE_A, "audio_001");
    expect(fetched?.variants.map((v) => v.kind).sort()).toEqual(["original", "transcript"]);
    expect(fetched?.updatedAt).toBeGreaterThan(1);
  });

  it("addVariant 对不存在的 id 抛 resource_not_found", async () => {
    await expect(
      portA.addVariant({
        workspaceKey: WORKSPACE_A,
        id: "missing",
        variant: { kind: "transcript", mime: "text/plain", bytes: 1 },
      }),
    ).rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("跨 workspace 隔离：workspace B 看不到 workspace A 的 entry", async () => {
    await portA.upsert(entry({ id: "img_iso" }));
    const fetchedB = await portB.getById(WORKSPACE_B, "img_iso");
    expect(fetchedB).toBeUndefined();
    const fetchedA = await portA.getById(WORKSPACE_A, "img_iso");
    expect(fetchedA).toBeDefined();
  });

  it("query 支持按 kind / textSearch 过滤与分页", async () => {
    for (let i = 0; i < 5; i++) {
      await portA.upsert(
        entry({
          id: `img_q${i}`,
          filename: `photo-${i}.png`,
          title: `photo-${i}`,
          addedAt: 100 + i,
          updatedAt: 100 + i,
        }),
      );
    }
    await portA.upsert(
      entry({
        id: "pdf_q0",
        kind: "pdf",
        filename: "doc.pdf",
        title: "document",
        addedAt: 200,
        updatedAt: 200,
      }),
    );
    const onlyImages = await portA.query({ workspaceKey: WORKSPACE_A, kinds: ["image"] });
    expect(onlyImages.entries).toHaveLength(5);
    const textResult = await portA.query({ workspaceKey: WORKSPACE_A, textSearch: "photo-2" });
    expect(textResult.entries).toHaveLength(1);
    expect(textResult.entries[0]?.id).toBe("img_q2");
    // 按 updated_at DESC 排序：pdf_q0 (updatedAt=200) 排第一，img_q4 (updatedAt=104) 排第二；取前 2 条。
    const pagedResult = await portA.query({ workspaceKey: WORKSPACE_A, limit: 2 });
    expect(pagedResult.entries).toHaveLength(2);
    expect(pagedResult.entries[0]?.id).toBe("pdf_q0");
    expect(pagedResult.entries[1]?.id).toBe("img_q4");
    expect(pagedResult.nextCursor).toBe("img_q4");
  });

  it("incrementReferences：累加 + clamp 到 0；不抛负数", async () => {
    await portA.upsert(entry({ id: "img_inc", references: 1 }));
    await portA.incrementReferences({ workspaceKey: WORKSPACE_A, ids: ["img_inc"], delta: 3 });
    let fetched = await portA.getById(WORKSPACE_A, "img_inc");
    expect(fetched?.references).toBe(4);
    await portA.incrementReferences({ workspaceKey: WORKSPACE_A, ids: ["img_inc"], delta: -10 });
    fetched = await portA.getById(WORKSPACE_A, "img_inc");
    expect(fetched?.references).toBe(0);
  });

  it("removeIfNotOrphaned：ref_count == 0 才删除；ref_count > 0 保留", async () => {
    await portA.upsert(entry({ id: "img_gc0" }));
    await portA.upsert(entry({ id: "img_gc1" }));
    await portA.incrementReferences({ workspaceKey: WORKSPACE_A, ids: ["img_gc1"], delta: 1 });
    // img_gc0 references=1, img_gc1 references=2。
    // 把 img_gc0 减到 0，期望被 GC；img_gc1 仍 > 0，保留。
    await portA.incrementReferences({ workspaceKey: WORKSPACE_A, ids: ["img_gc0"], delta: -1 });
    const removed = await portA.removeIfNotOrphaned({
      workspaceKey: WORKSPACE_A,
      ids: ["img_gc0", "img_gc1"],
    });
    expect(removed.removed).toEqual(["img_gc0"]);
    expect(await portA.getById(WORKSPACE_A, "img_gc0")).toBeUndefined();
    expect(await portA.getById(WORKSPACE_A, "img_gc1")).toBeDefined();
  });

  it("workspaceKey 为空字符串抛 workspace_key_invalid", async () => {
    await expect(
      portA.upsert(
        entry({
          workspaceIdentity: "",
          workspacePath: "",
        }),
      ),
    ).rejects.toMatchObject({ code: "workspace_key_invalid" });
  });

  it("query 跨 workspace 隔离：A 的 entries 不会出现在 B 的查询结果", async () => {
    await portA.upsert(entry({ id: "img_x" }));
    await portB.upsert(entry({ id: "img_x", workspaceIdentity: WORKSPACE_B }));
    const aEntries = await portA.query({ workspaceKey: WORKSPACE_A });
    const bEntries = await portB.query({ workspaceKey: WORKSPACE_B });
    expect(aEntries.entries).toHaveLength(1);
    expect(bEntries.entries).toHaveLength(1);
    expect(aEntries.entries[0]?.workspaceIdentity).toBe(WORKSPACE_A);
    expect(bEntries.entries[0]?.workspaceIdentity).toBe(WORKSPACE_B);
  });
});