import { basename, dirname, join, resolve } from "node:path";
import type {
  CapabilityEnvelope,
  FileSystemPort,
  LocalInfraPort,
  LocalParseResult,
  MineruTier,
  OcrSidecar,
} from "@zcode/contracts";
import {
  buildFailureEnvelope,
  buildOcrSidecar,
  buildSuccessEnvelope,
  evaluateOcrSidecarCache,
  normalizeLocalInfraError,
  ocrSidecarLocationFor,
} from "@zcode/core";
import { createReporter, exitCodeForEnvelope, type OcrContext, writeEnvelope } from "./output.js";
import {
  fingerprintSource,
  loadOcrSidecar,
  relativePathFrom,
  writeOcrSidecar,
} from "./sidecar-store.js";

/**
 * `zcode ocr parse` —— 解析一份本地文档（spec：capability-cli-blocks.md §5 / §6）。
 *
 * ⚠️ 档位**原样透传**给端口：合法性由端口判定（内部码 `engine_not_found`），
 * CLI 预校验会让验收 A4 要求的错误形状出不来。
 *
 * ⚠️ **缓存命中时不重跑引擎**（spec §6.5 接力矩阵）—— 这是「业务永远只传原始路径」
 * 的前提（D5）：业务不需要记住上一步的产物路径。
 */
export async function runParseCommand(
  ctx: OcrContext,
  port: LocalInfraPort,
  fileSystem: FileSystemPort,
  options: {
    readonly json: boolean;
    readonly path: string;
    readonly output?: string;
    readonly tier?: string;
    readonly force?: boolean;
    readonly pdfPassword?: string;
  },
): Promise<number> {
  const reporter = createReporter(ctx, options.json);
  const sourcePath = resolve(options.path);
  const location = ocrSidecarLocationFor(sourcePath);
  const warnings: string[] = [];

  // ── 1. 源文件的**内容**指纹（spec §6.5 判据 2）──
  const fingerprintResult = await fingerprintSource(fileSystem, sourcePath);
  if (!fingerprintResult.ok && fingerprintResult.reason === "not_found") {
    return emit(
      ctx,
      options.json,
      buildFailureEnvelope(
        "ocr.parse",
        {
          code: "not_found",
          message: `文件不存在：${sourcePath}`,
          hint: "确认路径后再试；--path 传的是待解析文件的路径",
          details: { reason: "not_found" },
        },
        { durationMs: 0, warnings },
      ),
    );
  }
  const fingerprint = fingerprintResult.ok ? fingerprintResult.fingerprint : undefined;
  if (fingerprint === undefined) {
    // ⚠️ **指纹取不到不是失败**：解析照做，只是没有缓存可命中、也不写 sidecar。
    warnings.push("源文件过大或不可读，未计算内容指纹：本次不做缓存命中判断，也不写 sidecar");
  }

  // ── 2. 缓存判定（`--force` 跳过全部判据）──
  if (options.force === true) {
    warnings.push("已指定 --force：忽略 sidecar 缓存，强制重算并覆盖 sidecar");
  } else if (fingerprint !== undefined) {
    const existing = await loadOcrSidecar(fileSystem, location.path);
    const decision = evaluateOcrSidecarCache(existing, {
      sourceSha256: fingerprint.sha256,
      ...(options.tier !== undefined ? { tier: options.tier } : {}),
      needsText: true,
    });
    if (decision.hit && existing !== undefined) {
      reporter.progress("analyze", "命中 sidecar 缓存，未重新识别");
      const cachedWarnings = [...warnings];
      // ⚠️ **请求没给 `--tier` 时命中任意档位**，但业务要看得见实际用的是哪一档。
      if (options.tier === undefined && decision.tier !== undefined) {
        cachedWarnings.push(`本次用的是 sidecar 里的档位 ${decision.tier}`);
      }
      return emit(
        ctx,
        options.json,
        buildSuccessEnvelope("ocr.parse", cachedOutput(existing, location.path), {
          durationMs: 0,
          warnings: cachedWarnings,
        }),
      );
    }
    if (decision.reason !== undefined) {
      warnings.push(`缓存未命中：${decision.reason}`);
    }
  }

  // ── 3. 跑引擎 ──
  reporter.progress("analyze", `开始解析：${sourcePath}`);
  const result = await port.parse({
    path: sourcePath,
    ...(options.output !== undefined ? { outputDir: options.output } : {}),
    ...(options.tier !== undefined
      ? {
          // 端口会在运行时校验档位枚举（§5.2 的 `engine_not_found`），
          // 这里刻意不做预校验，避免同一份校验逻辑出现两个来源。
          tier: options.tier as MineruTier,
        }
      : {}),
    // ⚠️ **sidecar 需要逐元素信息** ⇒ 这里必须要元素级模型（体积换接力能力）。
    documentModel: true,
    ...(options.pdfPassword !== undefined ? { password: options.pdfPassword } : {}),
  });
  // ⚠️ **进度信息只走 stderr**（spec §5.6）：引擎自己的 stdout 是人读文本
  // （`已解析 1 个输入。`），**不能混进 stdout 的 JSON**。
  if (result.stdout !== undefined && result.stdout.trim() !== "") {
    reporter.progress("analyze", result.stdout.trim());
  }

  if (!result.ok) {
    const error = result.error;
    return emit(
      ctx,
      options.json,
      buildFailureEnvelope(
        "ocr.parse",
        error !== undefined
          ? normalizeLocalInfraError(error)
          : { code: "internal", message: "解析失败，但端口没有给出错误详情" },
        {
          durationMs: result.durationMs,
          warnings: [...warnings, ...result.warnings],
          ...(result.degradedFrom !== undefined ? { degradedFrom: result.degradedFrom } : {}),
        },
      ),
    );
  }

  // ── 4. 写 sidecar（spec §6）──
  const artifactsDir = result.output?.outputDir;
  if (artifactsDir === undefined) {
    return emit(
      ctx,
      options.json,
      buildFailureEnvelope(
        "ocr.parse",
        { code: "internal", message: "解析成功，但端口没有给出产物目录" },
        { durationMs: result.durationMs, warnings: [...warnings, ...result.warnings] },
      ),
    );
  }
  const artifacts = artifactReferences(result, artifactsDir);
  const model = result.output?.documentModel;
  if (model === undefined) {
    warnings.push("未能提取逐元素模型：本次不写 sidecar（下一次调用会重新解析）");
  } else if (fingerprint !== undefined) {
    const sidecar = buildOcrSidecar({
      source: {
        // ⚠️ **相对 sidecar 所在目录**（sidecar 就在源文件旁 ⇒ 基名）。
        path: basename(sourcePath),
        sha256: fingerprint.sha256,
        bytes: fingerprint.bytes,
        mtimeMs: fingerprint.mtimeMs,
      },
      engine: {
        name: result.engine ?? "mineru",
        variant: "mineru",
        version: model.producer?.version ?? "unknown",
        // ⚠️ **权威档位来自产物**，不是请求值（端口已回填）。
        tier: result.tier ?? "unknown",
        route: "mineru",
        assets: {},
      },
      artifactsDir: relativePathFrom(location.directory, artifactsDir),
      pages: model.pages,
      ...(artifacts.markdownPath !== undefined ? { markdownPath: artifacts.markdownPath } : {}),
    });
    reporter.progress("write", `写入 sidecar：${location.path}`);
    await writeOcrSidecar(fileSystem, location.path, sidecar);
  }

  return emit(
    ctx,
    options.json,
    buildSuccessEnvelope(
      "ocr.parse",
      {
        cached: false,
        sidecarPath: location.path,
        artifactsDir: relativePathFrom(location.directory, artifactsDir),
        engine: result.engine ?? "mineru",
        ...(result.tier !== undefined ? { tier: result.tier } : {}),
        artifacts,
      },
      {
        durationMs: result.durationMs,
        warnings: [...warnings, ...result.warnings],
        ...(result.degradedFrom !== undefined ? { degradedFrom: result.degradedFrom } : {}),
      },
    ),
  );
}

/**
 * 产物引用（**相对 `artifactsDir`**）。
 *
 * ⚠️ 基准写死（spec §6.2）：业务按 `join(sidecar 目录, artifactsDir, 产物路径)` 还原。
 */
function artifactReferences(
  result: LocalParseResult,
  artifactsDir: string,
): Record<string, string> {
  const output = result.output;
  const references: Record<string, string> = {};
  if (output?.markdownPath !== undefined) {
    references.markdownPath = relativePathFrom(artifactsDir, output.markdownPath);
  }
  if (output?.structuredContentPath !== undefined) {
    references.structuredContentPath = relativePathFrom(artifactsDir, output.structuredContentPath);
  }
  if (output?.middleJsonPath !== undefined) {
    references.middleJsonPath = relativePathFrom(artifactsDir, output.middleJsonPath);
  }
  if (output?.assetsDir !== undefined) {
    references.assetsDir = relativePathFrom(artifactsDir, output.assetsDir);
  }
  return references;
}

/** 缓存命中时的输出（产物路径直接取 sidecar 里已归一的相对路径）。 */
function cachedOutput(sidecar: OcrSidecar, sidecarPath: string): Record<string, unknown> {
  const artifacts: Record<string, string> = {};
  const markdownPath = sidecar.text?.markdownPath;
  if (markdownPath !== undefined) {
    artifacts.markdownPath = markdownPath;
  }
  return {
    cached: true,
    sidecarPath,
    artifactsDir: sidecar.artifactsDir,
    engine: sidecar.engine.name,
    tier: sidecar.engine.tier,
    artifacts,
  };
}

/** 写信封（`--json`）或人读报告，并返回退出码。 */
function emit(ctx: OcrContext, json: boolean, envelope: CapabilityEnvelope): number {
  if (json) {
    writeEnvelope(ctx, envelope);
  } else {
    writeParseReport(ctx, envelope);
  }
  return exitCodeForEnvelope(envelope);
}

function writeParseReport(ctx: OcrContext, envelope: CapabilityEnvelope): void {
  const lines: string[] = [];
  if (!envelope.ok) {
    lines.push(`解析失败：${envelope.error.message}`);
    if (envelope.error.hint !== undefined) lines.push(`提示：${envelope.error.hint}`);
  } else {
    lines.push("解析成功");
    const output = envelope.output;
    const tier = output.tier;
    if (typeof tier === "string") {
      const degradedFrom = envelope.metrics?.degradedFrom;
      lines.push(
        `  档位：${tier}${degradedFrom !== undefined ? `（原请求 ${degradedFrom}，已降级）` : ""}`,
      );
    }
    if (typeof output.cached === "boolean") {
      lines.push(`  缓存：${output.cached ? "命中（未重新识别）" : "未命中"}`);
    }
    const sidecarPath = output.sidecarPath;
    if (typeof sidecarPath === "string") lines.push(`  sidecar：${sidecarPath}`);
    const artifactsDir = output.artifactsDir;
    if (typeof artifactsDir === "string" && typeof sidecarPath === "string") {
      lines.push(`  产物目录：${join(dirname(sidecarPath), artifactsDir)}`);
    }
    const artifacts = output.artifacts;
    if (artifacts !== undefined && typeof artifacts === "object") {
      const references = artifacts as Record<string, unknown>;
      for (const [name, value] of Object.entries(references)) {
        if (typeof value === "string") lines.push(`  ${name}：${value}`);
      }
    }
  }
  const warnings = envelope.metrics?.warnings ?? [];
  if (warnings.length > 0) {
    lines.push("告警：");
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }
  const durationMs = envelope.metrics?.durationMs;
  if (typeof durationMs === "number") lines.push(`耗时 ${(durationMs / 1000).toFixed(1)}s`);
  ctx.stdout.write(`${lines.join("\n")}\n`);
}
