import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DEGRADATION_POLICY } from "@zcode/contracts";
import { loadOcrRuntimeSettings } from "../src/config/ocr-config.js";

/**
 * `ocr.*` 配置段的读取（spec：docs/design/v2/capability-provisioning.md §6 / §8.2）。
 *
 * ⚠️ 这层是**唯一**的配置 owner —— `zcode ocr` 命令组与 runtime 的能力供给层
 * 都从这里读，两边必须看到同一份引擎路径与降级策略。
 */

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { force: true, recursive: true });
  }
});

async function makeWorkspace(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ocr-config-"));
  created.push(dir);
  await mkdir(join(dir, ".zcode"), { recursive: true });
  await writeFile(join(dir, ".zcode", "config.json"), JSON.stringify(config), "utf-8");
  return dir;
}

async function makeUserConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ocr-user-config-"));
  created.push(dir);
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(config), "utf-8");
  return path;
}

/** 不存在的用户级配置路径 —— 必须确定性，不能读开发机真实的 `~/.zcode/cli/config.json`。 */
async function missingUserConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ocr-user-config-"));
  created.push(dir);
  return join(dir, "absent.json");
}

describe("loadOcrRuntimeSettings", () => {
  it("defaults the degradation policy to error", async () => {
    const workspace = await makeWorkspace({});
    const settings = loadOcrRuntimeSettings(workspace, {
      userConfigPath: await missingUserConfig(),
    });

    expect(settings.degradation).toBe(DEFAULT_DEGRADATION_POLICY);
    expect(settings.degradation).toBe("error");
    expect(settings.infra).toEqual({});
  });

  it("reads the engine path and proxy policy from the project config", async () => {
    const workspace = await makeWorkspace({
      ocr: { mineruPath: "/opt/bin/mineru-kit", mineruProxy: "strip" },
    });
    const settings = loadOcrRuntimeSettings(workspace, {
      userConfigPath: await missingUserConfig(),
    });

    expect(settings.infra).toEqual({ mineruPath: "/opt/bin/mineru-kit", mineruProxy: "strip" });
  });

  it("project config wins over user config", async () => {
    const userConfigPath = await makeUserConfig({
      ocr: { mineruPath: "/user/bin/mineru-kit", degradation: "cloud" },
    });
    const workspace = await makeWorkspace({ ocr: { mineruPath: "/project/bin/mineru-kit" } });

    const settings = loadOcrRuntimeSettings(workspace, { userConfigPath });

    expect(settings.infra.mineruPath).toBe("/project/bin/mineru-kit");
    // 用户级配的 `cloud` 没被项目级覆盖 —— 项目级只覆盖了它自己声明的键。
    expect(settings.degradation).toBe("cloud");
  });

  it("keeps the reserved cloud policy visible instead of silently downgrading it", async () => {
    const userConfigPath = await makeUserConfig({ ocr: { degradation: "cloud" } });
    const workspace = await makeWorkspace({});

    const settings = loadOcrRuntimeSettings(workspace, { userConfigPath });

    // ⚠️ 配置层只负责**如实读出**；「cloud 未实现 ⇒ 明确报错」是判定层的职责。
    expect(settings.degradation).toBe("cloud");
  });
});
