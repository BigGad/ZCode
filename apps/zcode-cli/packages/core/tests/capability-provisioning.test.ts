import { describe, expect, it, vi } from "vitest";
import { createSessionId, MINERU_INSTALL_HINT } from "@zcode/contracts";
import type {
  LocalInfraDoctorReport,
  LocalInfraPort,
  LocalParseResult,
  MineruTier,
} from "@zcode/contracts";
import { resolveTurnAttachments } from "../src/runtime/helpers/attachments.js";
import {
  decideProvisioning,
  projectLocalReadiness,
  resolveLocalInfraReadiness,
  type LocalInfraProvisioning,
  type LocalInfraReadinessCache,
} from "../src/runtime/helpers/capability-provisioning/index.js";
import type {
  FileSystemPort,
  ImageProcessorPort,
  ModelInputFormat,
  PdfDocumentPort,
} from "../src/runtime/deps.js";

/**
 * 能力按需供给层（spec：docs/design/v2/capability-provisioning.md）的回归测试。
 *
 * ⚠️ 覆盖 A1–A8；A2 / A5 是**回归对** —— A5 断的是「有视觉能力时行为不变」。
 */

const PDF_BYTES = Buffer.from("%PDF-1.7\nlocal-ocr-body");
const MARKDOWN = "# 标题\n\n正文内容";
const SESSION_ARTIFACT_DIR = "/tmp/artifacts/session-1/ocr-0";
const MARKDOWN_PATH = `${SESSION_ARTIFACT_DIR}/doc.md`;

function noVisionFormat(): ModelInputFormat {
  return { supportsText: true, supportsImage: false, supportsPdf: false };
}

function readyReport(tier: MineruTier = "basic"): LocalInfraDoctorReport {
  return {
    engines: [
      {
        engine: "mineru",
        available: true,
        path: "/usr/local/bin/mineru-kit",
        versionToolAvailable: true,
        version: "4.1.7",
      },
    ],
    supportedTiers: ["flash", "basic", "standard", "advanced"],
    defaultTier: tier,
    models: [
      {
        tier,
        status: "ready",
        repos: [{ repo: "models", ready: true, path: "/tmp/models" }],
      },
    ],
    weightsFetched: false,
    durationMs: 12,
  };
}

function unavailableReport(): LocalInfraDoctorReport {
  return {
    engines: [
      {
        engine: "mineru",
        available: false,
        versionToolAvailable: false,
        reason: "未找到 mineru-kit 可执行文件",
        fix: MINERU_INSTALL_HINT,
      },
    ],
    supportedTiers: [],
    models: [],
    weightsFetched: false,
    durationMs: 8,
  };
}

function notReadyReport(): LocalInfraDoctorReport {
  return {
    engines: [
      {
        engine: "mineru",
        available: true,
        versionToolAvailable: true,
        version: "4.1.7",
      },
    ],
    supportedTiers: ["basic", "standard"],
    defaultTier: "basic",
    models: [{ tier: "basic", status: "missing", repos: [] }],
    weightsFetched: false,
    durationMs: 9,
  };
}

function fakeLocalInfraPort(input: {
  report?: LocalInfraDoctorReport;
  parseResult?: LocalParseResult;
  doctorError?: Error;
}): {
  port: LocalInfraPort;
  doctor: ReturnType<typeof vi.fn>;
  parse: ReturnType<typeof vi.fn>;
} {
  const doctor = vi.fn(async () => {
    if (input.doctorError) throw input.doctorError;
    return input.report ?? readyReport();
  });
  const parse = vi.fn(
    async () =>
      input.parseResult ?? {
        ok: true,
        engine: "mineru",
        tier: "basic",
        output: { outputDir: SESSION_ARTIFACT_DIR, markdownPath: MARKDOWN_PATH },
        warnings: [],
        durationMs: 1200,
      },
  );
  const port = { doctor, parse } as unknown as LocalInfraPort;
  return { port, doctor, parse };
}

function fakeFileSystemPort(hash = "sha256:aaaa"): FileSystemPort & {
  readTextFile: ReturnType<typeof vi.fn>;
} {
  const path = "/tmp/project/report.pdf";
  return {
    stat: vi.fn(async () => ({
      path,
      kind: "file" as const,
      mtimeMs: 1,
      sizeBytes: PDF_BYTES.byteLength,
    })),
    readBinaryFile: vi.fn(async () => ({
      path,
      content: PDF_BYTES,
      bytesRead: PDF_BYTES.byteLength,
      sizeBytes: PDF_BYTES.byteLength,
      revision: { id: "rev", mtimeMs: 1, sizeBytes: PDF_BYTES.byteLength, hash },
    })),
    readTextFile: vi.fn(async () => ({
      path: MARKDOWN_PATH,
      content: MARKDOWN,
      bytesRead: MARKDOWN.length,
      sizeBytes: MARKDOWN.length,
    })),
  } as unknown as FileSystemPort & { readTextFile: ReturnType<typeof vi.fn> };
}

function fakeArtifactStore(dir: string | null = SESSION_ARTIFACT_DIR): {
  resolveSessionArtifactDir: ReturnType<typeof vi.fn>;
  writeToolResultArtifact: ReturnType<typeof vi.fn>;
} {
  return {
    resolveSessionArtifactDir: vi.fn(async () => (dir === null ? undefined : { path: dir })),
    writeToolResultArtifact: vi.fn(async () => ({
      uri: "zcode-artifact://local-ocr-test",
      bytes: PDF_BYTES.byteLength,
      contentType: "application/pdf",
      createdAt: new Date(),
      id: "local-ocr-test",
    })),
  };
}

function fakeResourceIndexPort(): { upsert: ReturnType<typeof vi.fn> } {
  return { upsert: vi.fn(async () => undefined) };
}

/**
 * 按子目录展开的产物仓库（模拟真实的 `<artifacts>/<sessionId>/<subdir>` 布局）。
 *
 * ⚠️ 引擎的 `prepareOutputDir` 是**先删再建** ⇒ 目录名撞车会把上一轮的产物清空。
 */
function subdirArtifactStore(): {
  resolveSessionArtifactDir: ReturnType<typeof vi.fn>;
  writeToolResultArtifact: ReturnType<typeof vi.fn>;
} {
  return {
    resolveSessionArtifactDir: vi.fn(async (request: { subdir?: string }) => ({
      path: `/tmp/artifacts/session-1/${request.subdir ?? ""}`,
    })),
    writeToolResultArtifact: vi.fn(async () => ({
      uri: "zcode-artifact://local-ocr-test",
      bytes: PDF_BYTES.byteLength,
      contentType: "application/pdf",
      createdAt: new Date(),
      id: "local-ocr-test",
    })),
  };
}

function fakePdfDocumentPort(): PdfDocumentPort {
  return {
    getPageCount: vi.fn(async () => 2),
    renderPages: vi.fn(async () => [
      { data: new Uint8Array(16), mediaType: "image/jpeg" as const, pageNumber: 1 },
      { data: new Uint8Array(16), mediaType: "image/jpeg" as const, pageNumber: 2 },
    ]),
  } as unknown as PdfDocumentPort;
}

function fakeImageProcessorPort(): ImageProcessorPort {
  return {
    prepareForModel: vi.fn(async (request: { data: Uint8Array; mediaType: string }) => ({
      data: request.data,
      mediaType: request.mediaType,
      resized: false,
      originalWidth: 800,
      originalHeight: 1000,
      width: 800,
      height: 1000,
      compressed: false,
      strategy: "original",
      originalSizeBytes: request.data.byteLength,
      transformedSizeBytes: request.data.byteLength,
    })),
  } as unknown as ImageProcessorPort;
}

function localInfra(input: {
  port: LocalInfraPort;
  degradation?: "error" | "cloud";
  readiness?: () => Promise<ReturnType<typeof projectLocalReadiness> | undefined>;
}): LocalInfraProvisioning {
  return {
    port: input.port,
    degradation: input.degradation ?? "error",
    resolveReadiness:
      input.readiness ?? (async () => projectLocalReadiness(await input.port.doctor())),
  };
}

async function resolvePdf(options: {
  localInfra?: LocalInfraProvisioning;
  modelInputFormat?: ModelInputFormat;
  artifactStore?: ReturnType<typeof fakeArtifactStore> | ReturnType<typeof subdirArtifactStore>;
  fileSystemPort?: ReturnType<typeof fakeFileSystemPort>;
  resourceIndexPort?: ReturnType<typeof fakeResourceIndexPort>;
  pdfDocumentPort?: PdfDocumentPort;
  imageProcessorPort?: ImageProcessorPort;
}) {
  const artifactStore = options.artifactStore ?? fakeArtifactStore();
  const resourceIndexPort = options.resourceIndexPort ?? fakeResourceIndexPort();
  const resolved = await resolveTurnAttachments([{ type: "pdf", path: "report.pdf" }], {
    artifactStore: artifactStore as never,
    fileSystemPort: options.fileSystemPort ?? fakeFileSystemPort(),
    modelInputFormat: options.modelInputFormat ?? noVisionFormat(),
    sessionId: createSessionId("local-ocr-session"),
    traceContext: { traceId: "trace_local_ocr" },
    workingDirectory: "/tmp/project",
    workspaceKey: "/tmp/project",
    workspaceResourceIndexPort: resourceIndexPort as never,
    ...(options.localInfra !== undefined ? { localInfra: options.localInfra } : {}),
    ...(options.pdfDocumentPort !== undefined ? { pdfDocumentPort: options.pdfDocumentPort } : {}),
    ...(options.imageProcessorPort !== undefined
      ? { imageProcessorPort: options.imageProcessorPort }
      : {}),
  });
  return { resolved: resolved[0], artifactStore, resourceIndexPort };
}

describe("能力供给层：就绪状态投影（A1）", () => {
  it("引擎缺失 ⇒ 不可用 + 装法", () => {
    const projection = projectLocalReadiness(unavailableReport());
    expect(projection.status).toBe("unavailable");
    expect(projection.installCommand).toBe(MINERU_INSTALL_HINT);
  });

  it("三层全绿 ⇒ 就绪 + 档位", () => {
    const projection = projectLocalReadiness(readyReport("standard"));
    expect(projection.status).toBe("ready");
    expect(projection.tier).toBe("standard");
  });

  it("模型未下载 ⇒ 未就位 + 下载命令（与「不可用」分开）", () => {
    const projection = projectLocalReadiness(notReadyReport());
    expect(projection.status).toBe("not-ready");
    expect(projection.downloadCommand).toBe("zcode ocr models download --tier basic");
    expect(projection.installCommand).toBeUndefined();
  });

  it("体检失败 ⇒ 未知（不假装就绪），且同轮只探测一次", async () => {
    const { port, doctor } = fakeLocalInfraPort({ doctorError: new Error("spawn failed") });
    const cache: LocalInfraReadinessCache = {};
    const first = await resolveLocalInfraReadiness({ cache, turnId: "turn-1", port });
    const second = await resolveLocalInfraReadiness({ cache, turnId: "turn-1", port });

    expect(first?.status).toBe("unknown");
    expect(first?.reason).toContain("体检失败");
    expect(second).toBe(first);
    expect(doctor).toHaveBeenCalledTimes(1);
  });
});

describe("能力供给层：判定规则（A8 / A7）", () => {
  it("本地引擎候选 + 就绪 ⇒ rule-6 + 理由", async () => {
    const decision = await decideProvisioning({
      attachmentKind: "pdf",
      modelInputFormat: noVisionFormat(),
      degradation: "error",
      resolveReadiness: async () => projectLocalReadiness(readyReport()),
    });
    expect(decision.ruleId).toBe("rule-6");
    expect(decision.route).toBe("local-engine");
    expect(decision.degradation).toBe("error");
    expect(decision.reason).toContain("本地解析引擎已就绪");
  });

  it("降级策略配成 cloud ⇒ 明确报错（rule-11），不悄悄按 error 执行", async () => {
    const decision = await decideProvisioning({
      attachmentKind: "pdf",
      modelInputFormat: noVisionFormat(),
      degradation: "cloud",
      resolveReadiness: async () => projectLocalReadiness(readyReport()),
    });
    expect(decision.ruleId).toBe("rule-11");
    expect(decision.route).toBe("error");
    expect(decision.reason).toContain("尚未实现");
  });

  it("能力位未知 ⇒ 维持现状，不委派", async () => {
    const decision = await decideProvisioning({
      attachmentKind: "pdf",
      modelInputFormat: { supportsText: true },
      degradation: "error",
      resolveReadiness: async () => projectLocalReadiness(readyReport()),
    });
    expect(decision.ruleId).toBe("rule-10");
    expect(decision.route).toBe("existing");
  });

  it("供给层未装配 ⇒ 维持现状，不委派也不报错", async () => {
    const decision = await decideProvisioning({
      attachmentKind: "pdf",
      modelInputFormat: noVisionFormat(),
      degradation: "error",
    });
    expect(decision.ruleId).toBe("rule-10");
    expect(decision.route).toBe("existing");
  });
});

describe("能力供给层：附件链（A2–A6）", () => {
  it("A2：模型既不支持图片也不支持 PDF + 本地就位 ⇒ 自动走本地引擎，markdown 进 prompt", async () => {
    const { port, parse } = fakeLocalInfraPort({});
    const { resolved, artifactStore, resourceIndexPort } = await resolvePdf({
      localInfra: localInfra({ port }),
    });

    expect(parse).toHaveBeenCalledTimes(1);
    // 产物目录必须是会话级 artifact 目录，不是源文件旁。
    expect(parse.mock.calls[0]![0].outputDir).toBe(SESSION_ARTIFACT_DIR);
    expect(artifactStore.resolveSessionArtifactDir).toHaveBeenCalledTimes(1);

    expect(resolved?.contentBlock.type).toBe("text");
    const text = (resolved?.contentBlock as { text: string }).text;
    expect(text).toContain(MARKDOWN);
    expect(text).toContain("local OCR engine");

    // OCR 产物登记成 `ocr` 变体。
    await new Promise((resolve) => setImmediate(resolve));
    const entry = resourceIndexPort.upsert.mock.calls[0]![0];
    const variants = entry.variants as { kind: string }[];
    expect(variants.map((variant) => variant.kind)).toContain("ocr");
  });

  it("A3：本地不可用 ⇒ 明确报错 + 确切安装命令", async () => {
    const { port, parse } = fakeLocalInfraPort({ report: unavailableReport() });
    const { resolved } = await resolvePdf({ localInfra: localInfra({ port }) });

    expect(parse).not.toHaveBeenCalled();
    const text = (resolved?.contentBlock as { text: string }).text;
    expect(text).toContain(MINERU_INSTALL_HINT);
    expect(text).toContain("Next step:");
  });

  it("A4：模型未就位 ⇒ 明确报错 + 确切下载命令", async () => {
    const { port, parse } = fakeLocalInfraPort({ report: notReadyReport() });
    const { resolved } = await resolvePdf({ localInfra: localInfra({ port }) });

    expect(parse).not.toHaveBeenCalled();
    const text = (resolved?.contentBlock as { text: string }).text;
    expect(text).toContain("zcode ocr models download --tier basic");
  });

  it("A5：模型有视觉能力 ⇒ 走现有页图渲染路线（行为不变），不碰本地引擎", async () => {
    const { port, parse } = fakeLocalInfraPort({});
    const { resolved } = await resolvePdf({
      localInfra: localInfra({ port }),
      modelInputFormat: { supportsImage: true } as ModelInputFormat,
      pdfDocumentPort: fakePdfDocumentPort(),
      imageProcessorPort: fakeImageProcessorPort(),
    });

    expect(parse).not.toHaveBeenCalled();
    expect(resolved?.contentBlocks).toBeDefined();
    expect(resolved?.contentBlocks?.[0]?.type).toBe("image");
  });

  it("A6：引擎调用失败 ⇒ 报错带引擎原因，不重跑、不换路", async () => {
    const { port, parse } = fakeLocalInfraPort({
      parseResult: {
        ok: false,
        error: {
          code: "process_failed",
          message: "本地解析引擎执行失败。",
          hint: "mineru-kit: CUDA out of memory",
        },
        warnings: [],
        durationMs: 30,
      },
    });
    const { resolved } = await resolvePdf({ localInfra: localInfra({ port }) });

    expect(parse).toHaveBeenCalledTimes(1);
    const text = (resolved?.contentBlock as { text: string }).text;
    expect(text).toContain("本地解析引擎执行失败。");
    expect(text).toContain("CUDA out of memory");
  });

  it("拿不到会话级产物目录 ⇒ 放弃本地路线并明确报错（不落在源文件旁）", async () => {
    const { port, parse } = fakeLocalInfraPort({});
    const { resolved } = await resolvePdf({
      localInfra: localInfra({ port }),
      artifactStore: fakeArtifactStore(null),
    });

    expect(parse).not.toHaveBeenCalled();
    const text = (resolved?.contentBlock as { text: string }).text;
    expect(text).toContain("could not be parsed");
  });

  it("引擎失败 ⇒ 投递的文本与声明的字节数一致（不是 0）", async () => {
    const { port } = fakeLocalInfraPort({
      parseResult: {
        ok: false,
        error: { code: "process_failed", message: "本地解析引擎执行失败。" },
        warnings: [],
        durationMs: 30,
      },
    });
    const { resolved } = await resolvePdf({ localInfra: localInfra({ port }) });

    const text = (resolved?.contentBlock as { text: string }).text;
    expect(text.length).toBeGreaterThan(0);
    expect(resolved?.metadata?.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("产物目录按内容指纹隔离：同一会话里不同文档不共用目录（引擎会清空目录）", async () => {
    const { port, parse } = fakeLocalInfraPort({});
    const artifactStore = subdirArtifactStore();

    await resolvePdf({
      localInfra: localInfra({ port }),
      artifactStore,
      fileSystemPort: fakeFileSystemPort("sha256:aaaa1111"),
    });
    await resolvePdf({
      localInfra: localInfra({ port }),
      artifactStore,
      fileSystemPort: fakeFileSystemPort("sha256:bbbb2222"),
    });

    expect(parse).toHaveBeenCalledTimes(2);
    const first = parse.mock.calls[0]![0].outputDir as string;
    const second = parse.mock.calls[1]![0].outputDir as string;
    expect(first).not.toBe(second);
  });

  it("产物目录按内容指纹隔离：同一份文档重复解析落在同一目录（幂等）", async () => {
    const { port, parse } = fakeLocalInfraPort({});
    const artifactStore = subdirArtifactStore();

    await resolvePdf({
      localInfra: localInfra({ port }),
      artifactStore,
      fileSystemPort: fakeFileSystemPort("sha256:aaaa1111"),
    });
    await resolvePdf({
      localInfra: localInfra({ port }),
      artifactStore,
      fileSystemPort: fakeFileSystemPort("sha256:aaaa1111"),
    });

    expect(parse.mock.calls[0]![0].outputDir).toBe(parse.mock.calls[1]![0].outputDir);
  });
});
