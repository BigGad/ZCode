import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalInfraPort } from "../../src/local-infra/index.js";
import { parseModelsShow, toTierModelStatuses } from "../../src/local-infra/models-status.js";
import { createNodeFileSystemAdapter } from "../../src/fs/index.js";
import {
  argvOf,
  completedResult,
  createFakeEngine,
  fakeExecutionPort,
  hardwareDetectJson,
  modelsShowMissingText,
  modelsShowText,
} from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 找某个档位在报告里的视图（找不到就报错，别让断言静默通过）。 */
function tierOf(tiers: readonly { tier: string }[], tier: string) {
  const found = tiers.find((entry) => entry.tier === tier);
  expect(found, `报告里没有 ${tier} 档`).toBeDefined();
  return found!;
}

describe("档位状态映射（local-infra.md §5.4）", () => {
  it("全新机器：引擎明确报出仓库「缺失」⇒ 落成 missing（不是 unknown），并给下载命令", () => {
    // 修复依据（2026-11-11）：原先只要「没有任何仓库就绪」就落成 unknown，
    // 于是全新机器上 basic 档被报成 unknown ⇒ 能力供给层判成「问不出来」，
    // **自动备资产永远不触发**（spec：capability-provisioning.md A15）。
    const statuses = toTierModelStatuses(parseModelsShow(modelsShowMissingText()));

    const basic = tierOf(statuses, "basic");
    expect(basic.status).toBe("missing");
    expect(basic.downloadCommand).toBe("zcode ocr models download --tier basic");

    const standard = tierOf(statuses, "standard");
    expect(standard.status).toBe("missing");
    expect(standard.downloadCommand).toBe("zcode ocr models download --tier standard");
  });

  it("权重已下好 ⇒ 落成 ready，且不给下载命令", () => {
    const statuses = toTierModelStatuses(parseModelsShow(modelsShowText()));

    const basic = tierOf(statuses, "basic");
    expect(basic.status).toBe("ready");
    expect(basic.downloadCommand).toBeUndefined();
    expect(basic.repos).toHaveLength(1);
    expect(basic.repos[0]).toMatchObject({ repo: "MinerU-4_models_torch", ready: true });
  });

  it("部分就绪 + 部分缺失 ⇒ 落成 missing", () => {
    const text = [
      "仓库:",
      "  MinerU-4_models_torch: 就绪 (/tmp/torch)",
      "  MinerU2.5-Pro-2605-1.2B-GGUF: 缺失 (/tmp/gguf)",
      "模型档位:",
      "  basic: MinerU-4_models_torch",
      "  standard: MinerU-4_models_torch, MinerU2.5-Pro-2605-1.2B-GGUF",
    ].join("\n");

    const statuses = toTierModelStatuses(parseModelsShow(text));

    expect(tierOf(statuses, "basic").status).toBe("ready");
    expect(tierOf(statuses, "standard").status).toBe("missing");
  });

  it("无仓库映射的档位（flash / advanced）⇒ unknown，且**不给**下载命令", () => {
    // MinerU 的 `models download --tier` 只接受 basic / standard ⇒ 给别的档位
    // 编命令 = 编一个用户跑不动的命令。
    const statuses = toTierModelStatuses(parseModelsShow(modelsShowText()));

    const flash = tierOf(statuses, "flash");
    expect(flash.status).toBe("unknown");
    expect(flash.downloadCommand).toBeUndefined();
    expect(tierOf(statuses, "advanced").downloadCommand).toBeUndefined();
  });

  it("引擎输出里查不到必需仓库的状态 ⇒ unknown（问不出来，不谎报缺失）", () => {
    // 仓库段整个缺失（例如 `models show` 被截断）⇒ 只能说不知道。
    const text = ["模型档位:", "  basic: MinerU-4_models_torch"].join("\n");

    const statuses = toTierModelStatuses(parseModelsShow(text));

    const basic = tierOf(statuses, "basic");
    expect(basic.status).toBe("unknown");
    expect(basic.downloadCommand).toBeUndefined();
  });
});

describe("doctor 报告里的档位状态", () => {
  it("全新机器上 basic 档报 missing（端到端：引擎输出 ⇒ 报告）", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
    roots.push(root);
    const kitPath = await createFakeEngine(root);
    const execution = fakeExecutionPort(async (request) => {
      const args = argvOf(request);
      if (args[0] === "hardware" && args[1] === "detect") {
        return completedResult({ stdout: hardwareDetectJson({}) });
      }
      if (args[0] === "models" && args[1] === "show") {
        return completedResult({ stdout: modelsShowMissingText() });
      }
      if (args[0] === "version") {
        return completedResult({ stdout: JSON.stringify({ mineru_version: "4.1.7" }) });
      }
      if (args[0] === "--version") {
        return completedResult({ stdout: "MinerU 版本: 4.1.7\n" });
      }
      return completedResult();
    });
    const port = createLocalInfraPort({
      execution,
      fileSystem: createNodeFileSystemAdapter(),
      config: { mineruPath: kitPath },
    });

    const report = await port.doctor();

    const basic = tierOf(report.models, "basic");
    expect(basic.status).toBe("missing");
    expect(basic.downloadCommand).toBe("zcode ocr models download --tier basic");
  });
});
