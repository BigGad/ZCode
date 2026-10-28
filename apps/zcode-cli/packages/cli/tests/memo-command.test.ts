import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import {
  MEMO_EXIT_INVALID,
  MEMO_EXIT_IO_ERROR,
  MEMO_EXIT_OK,
  runMemoCommand,
} from "../src/memo-command.js";

/**
 * `zcode memo validate`（spec: `docs/design/v2/memo-v30-contract.md` §6）。
 *
 * 退出码：0 通过（含软违） / 1 硬违或结构不合法 / 2 文件读不到或不是合法 JSON。
 */

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

const options: GlobalOptions = {
  force: false,
  json: false,
  noColor: true,
  verbose: false,
};

function baseDocument(): Record<string, unknown> {
  return {
    case: { name: "赵阳阳职务侵占案", case_no: "高密检刑诉受〔2026〕370785000041号", volumes: 54 },
    volume: { no: "03", theme: "笔录类", page_total: 123 },
    catalog: [{ kind: "item", seq: 1, title: "赵阳阳第1次讯问笔录", page_ref: "【卷03·第4-11页】" }],
    evidence: [
      {
        seq: 1,
        type: "言词证据",
        output_mode: "replica",
        title: "赵阳阳第1次讯问笔录",
        page_ref: "【卷03·第4-11页】",
        page_numbers: [4, 5, 6, 7, 8, 9, 10, 11],
        meta: {
          time: "2025年10月29日09时55分至11时30分",
          place: "高密市公安局执法办案管理中心经济开发区分中心",
          interviewer: "文婷",
          interviewee: "赵阳阳",
          recorder: "张伟",
        },
        deleted: "权利义务告知书、个人基本信息（含身份证号）",
        body: [],
      },
    ],
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-memo-command-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("合法文档 → 退出码 0", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "memo_v30.json"), JSON.stringify(baseDocument()), "utf8");
    const { ctx, stdout } = context();
    const code = await runMemoCommand(ctx, options, ["validate", "memo_v30.json"], {
      workingDirectory: dir,
    });
    assert.equal(code, MEMO_EXIT_OK);
    assert.match(stdout.output(), /通过/);
  });
});

test("缺必填要素 → CF-02 硬违，退出码 1", async () => {
  await withTempDir(async (dir) => {
    const doc = baseDocument();
    const evidence = doc["evidence"] as Array<Record<string, unknown>>;
    const meta = evidence[0]!["meta"] as Record<string, string>;
    delete meta["interviewer"];
    await writeFile(join(dir, "memo_v30.json"), JSON.stringify(doc), "utf8");
    const { ctx, stdout } = context();
    const code = await runMemoCommand(ctx, options, ["validate", "memo_v30.json"], {
      workingDirectory: dir,
    });
    assert.equal(code, MEMO_EXIT_INVALID);
    assert.match(stdout.output(), /CF-02/);
    assert.match(stdout.output(), /interviewer/);
  });
});

test("replica 带了正文 → CF-08 软违，仍判通过", async () => {
  await withTempDir(async (dir) => {
    const doc = baseDocument();
    const evidence = doc["evidence"] as Array<Record<string, unknown>>;
    evidence[0]!["body"] = [{ kind: "q", text: "问：有没有转移过款项？" }];
    await writeFile(join(dir, "memo_v30.json"), JSON.stringify(doc), "utf8");
    const { ctx, stdout } = context();
    const code = await runMemoCommand(ctx, options, ["validate", "memo_v30.json"], {
      workingDirectory: dir,
    });
    assert.equal(code, MEMO_EXIT_OK);
    assert.match(stdout.output(), /CF-08/);
    assert.match(stdout.output(), /软警告/);
  });
});

test("目录与正文条数不一致 → CF-06 硬违，退出码 1", async () => {
  await withTempDir(async (dir) => {
    const doc = baseDocument();
    doc["catalog"] = [];
    await writeFile(join(dir, "memo_v30.json"), JSON.stringify(doc), "utf8");
    const { ctx, stdout } = context();
    const code = await runMemoCommand(ctx, options, ["validate", "memo_v30.json"], {
      workingDirectory: dir,
    });
    assert.equal(code, MEMO_EXIT_INVALID);
    assert.match(stdout.output(), /CF-06/);
  });
});

test("文件读不到 → 退出码 2", async () => {
  await withTempDir(async (dir) => {
    const { ctx, stderr } = context();
    const code = await runMemoCommand(ctx, options, ["validate", "不存在.json"], {
      workingDirectory: dir,
    });
    assert.equal(code, MEMO_EXIT_IO_ERROR);
    assert.match(stderr.output(), /Cannot read/);
  });
});

test("不是合法 JSON → 退出码 2", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "memo_v30.json"), "{ 不是 JSON", "utf8");
    const { ctx, stderr } = context();
    const code = await runMemoCommand(ctx, options, ["validate", "memo_v30.json"], {
      workingDirectory: dir,
    });
    assert.equal(code, MEMO_EXIT_IO_ERROR);
    assert.match(stderr.output(), /not valid JSON/);
  });
});

test("--json 输出机器可读载荷", async () => {
  await withTempDir(async (dir) => {
    const doc = baseDocument();
    const evidence = doc["evidence"] as Array<Record<string, unknown>>;
    const meta = evidence[0]!["meta"] as Record<string, string>;
    delete meta["interviewer"];
    await writeFile(join(dir, "memo_v30.json"), JSON.stringify(doc), "utf8");
    const { ctx, stdout } = context();
    const code = await runMemoCommand(
      ctx,
      { ...options, json: true },
      ["validate", "memo_v30.json"],
      { workingDirectory: dir },
    );
    assert.equal(code, MEMO_EXIT_INVALID);
    const payload = JSON.parse(stdout.output()) as {
      ok: boolean;
      violations: Array<{ id: string; hint: string }>;
      warnings: unknown[];
      structureIssues: unknown[];
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.violations[0]?.id, "CF-02");
    assert.ok((payload.violations[0]?.hint ?? "").length > 0);
    assert.deepEqual(payload.warnings, []);
    assert.deepEqual(payload.structureIssues, []);
  });
});

test("缺子命令 / 缺文件 → 退出码 1 并给出用法", async () => {
  const { ctx, stderr } = context();
  assert.equal(await runMemoCommand(ctx, options, []), MEMO_EXIT_INVALID);
  assert.match(stderr.output(), /validate/);
});
