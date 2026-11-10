import type { LocalInfraDoctorReport, LocalInfraPort } from "@zcode/contracts";
import { OCR_EXIT_OK, type OcrContext, writeJson } from "./output.js";

/**
 * `zcode ocr doctor` —— 本地解析引擎体检。
 *
 * ⚠️ **只读**：不下载权重、不装依赖、不写任何状态。
 * ⚠️ **退出码恒为 0**（除非参数非法）：体检报告本身就是结果，"不可用"是**有效报告**
 * 而不是命令失败。
 * ⚠️ 标题必须写"本地解析引擎体检"——`zcode doctor` 是另一回事（运行时与打包假设检查）。
 */
export async function runDoctorCommand(
  ctx: OcrContext,
  port: LocalInfraPort,
  options: { readonly json: boolean },
): Promise<number> {
  const report = await port.doctor();
  if (options.json) {
    writeJson(ctx, report);
    return OCR_EXIT_OK;
  }
  writeDoctorReport(ctx, report);
  return OCR_EXIT_OK;
}

function writeDoctorReport(ctx: OcrContext, report: LocalInfraDoctorReport): void {
  const lines: string[] = ["本地解析引擎体检"];
  for (const engine of report.engines) {
    lines.push(`引擎 ${engine.engine}：${engine.available ? "可用" : "不可用"}`);
    if (engine.path !== undefined) lines.push(`  可执行文件：${engine.path}`);
    if (engine.version !== undefined) lines.push(`  版本：${engine.version}`);
    lines.push(
      engine.versionToolAvailable
        ? `  版本检查工具：${engine.versionToolPath ?? "（同目录 sibling）"}`
        : "  版本检查工具：缺失（不影响解析）",
    );
    if (engine.reason !== undefined) lines.push(`  原因：${engine.reason}`);
    if (engine.fix !== undefined) lines.push(`  安装：${engine.fix}`);
  }

  if (report.ceilingTier !== undefined) lines.push(`档位上限：${report.ceilingTier}`);
  lines.push(
    report.supportedTiers.length > 0
      ? `支持档位：${report.supportedTiers.join("、")}`
      : "支持档位：未知",
  );
  if (report.defaultTier !== undefined) lines.push(`默认档位：${report.defaultTier}`);
  if (report.device !== undefined) lines.push(`推理设备：${report.device}`);

  if (report.models.length > 0) {
    lines.push("模型就绪情况：");
    for (const model of report.models) {
      const repos =
        model.repos.length > 0
          ? `（${model.repos.map((repo) => `${repo.repo}${repo.ready ? " 就绪" : " 缺失"}`).join("、")}）`
          : "";
      lines.push(`  ${model.tier}：${model.status}${repos}`);
      if (model.downloadCommand !== undefined) {
        lines.push(`    下载命令：${model.downloadCommand}`);
      }
    }
  }

  lines.push("本次体检未下载任何权重。");
  ctx.stdout.write(`${lines.join("\n")}\n`);
}
