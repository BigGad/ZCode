import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locateMineruKit } from "../../src/local-infra/engine-locator.js";
import { decideTier, parseHardwareDetect } from "../../src/local-infra/tier-selection.js";
import { createFakeEngine } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("引擎定位", () => {
  it("PATH 与常见目录都找不到时报找不到，并列出找过的位置", async () => {
    // 开发机自己可能装了 MinerU（`~/.local/bin`）⇒ 必须把 HOME 也换掉，
    // 否则"找不到引擎"这条路径根本走不到。
    const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
    roots.push(root);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await locateMineruKit({ env: { PATH: "" } });

      expect(result.engine).toBeUndefined();
      expect(result.reason).toContain("mineru-kit");
      expect(result.searched.length).toBeGreaterThan(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("显式配置的路径不可用时直接失败，不回退到 PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
    roots.push(root);

    const result = await locateMineruKit({
      env: { PATH: "" },
      configuredPath: join(root, "missing", "mineru-kit"),
    });

    expect(result.engine).toBeUndefined();
    expect(result.reason).toContain("配置的");
  });

  it("显式配置的路径可用时按配置命中，并推导同目录的版本检查工具", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-infra-"));
    roots.push(root);
    const kitPath = await createFakeEngine(root);

    const result = await locateMineruKit({ configuredPath: kitPath });

    expect(result.engine).toMatchObject({ path: kitPath, source: "config" });
    expect(result.engine?.versionToolPath).toBe(join(root, "fake-bin", "mineru"));
  });
});

describe("档位判定", () => {
  it("解析 hardware detect 的 JSON", () => {
    const probe = parseHardwareDetect(
      JSON.stringify({
        ceiling: "standard",
        pdf_image_tiers: ["flash", "basic", "standard"],
        default_request_tier: "basic",
        device: "mps",
        calibration: { note: "x" },
      }),
    );

    expect(probe).toMatchObject({
      ceiling: "standard",
      pdfImageTiers: ["flash", "basic", "standard"],
      defaultRequestTier: "basic",
      device: "mps",
    });
    expect(probe?.calibration).toEqual({ note: "x" });
  });

  it("hardware detect 不是 JSON 时不编造档位", () => {
    expect(parseHardwareDetect("not json")).toBeUndefined();
  });

  it("没指定档位时用引擎建议的默认档位", () => {
    const decision = decideTier({
      hardware: parseHardwareDetect(
        JSON.stringify({ pdf_image_tiers: ["flash", "basic"], default_request_tier: "basic" }),
      ),
    });

    expect(decision.tier).toBe("basic");
    expect(decision.degradedFrom).toBeUndefined();
    expect(decision.error).toBeUndefined();
  });

  it("请求的档位本机不支持时降级到 ceiling 并标记降级来源", () => {
    const decision = decideTier({
      requested: "advanced",
      hardware: parseHardwareDetect(
        JSON.stringify({ ceiling: "standard", pdf_image_tiers: ["flash", "basic", "standard"] }),
      ),
    });

    expect(decision.error).toBeUndefined();
    expect(decision.tier).toBe("standard");
    expect(decision.degradedFrom).toBe("advanced");
    expect(decision.warnings.join("\n")).toContain("产物形状可能与请求档位不同");
  });

  it("档位不在官方枚举内时报 engine_not_found", () => {
    const decision = decideTier({ requested: "turbo" as never });

    expect(decision.error?.code).toBe("engine_not_found");
    expect(decision.tier).toBeUndefined();
  });

  it("内存不足时降级并说明原因", () => {
    const decision = decideTier({
      requested: "advanced",
      hardware: parseHardwareDetect(
        JSON.stringify({
          ceiling: "advanced",
          pdf_image_tiers: ["flash", "basic", "standard", "advanced"],
        }),
      ),
      systemMemoryBytes: 4 * 1024 ** 3,
    });

    // advanced 要 16GiB、standard 要 8GiB ⇒ 4GiB 机器只能退到 basic（2GiB）。
    expect(decision.tier).toBe("basic");
    expect(decision.degradedFrom).toBe("advanced");
    expect(decision.warnings.join("\n")).toContain("内存");
  });
});
