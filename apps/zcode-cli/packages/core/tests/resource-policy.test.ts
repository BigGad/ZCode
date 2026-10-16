import { describe, expect, it } from "vitest";
import {
  parseResourcePolicy,
  ResourcePolicyParseError,
} from "../src/runtime/helpers/resource-policy/parser.js";
import { resolvePolicyForEntry } from "../src/runtime/helpers/resource-policy/resolver.js";
import type { WorkspaceResourceIndexEntry } from "@zcode/contracts";

const YAML_OK = `
version: 1
video:
  frameSampling:
    default:
      intervalSec: 10
      maxFrames: 60
      mode: uniform
    byTag:
      screen-recording:
        intervalSec: 2
        maxFrames: 300
        mode: uniform
      product-walkthrough:
        mode: explicit
        manualTimesMs: [0, 8000, 15500]
audio:
  transcription:
    default:
      engine: whisper-local
      language: auto
    byTag:
      meeting:
        engine: whisper-local
        language: zh-CN
audioOutput:
  default:
    voice: alloy
    format: mp3
`;

describe("resource-policy parser", () => {
  it("valid yaml 解析并保留 byTag / default", () => {
    const policy = parseResourcePolicy(YAML_OK);
    expect(policy.version).toBe(1);
    expect(policy.video?.frameSampling?.default?.intervalSec).toBe(10);
    expect(policy.video?.frameSampling?.byTag?.["screen-recording"]?.intervalSec).toBe(2);
    expect(
      policy.video?.frameSampling?.byTag?.["product-walkthrough"]?.manualTimesMs,
    ).toEqual([0, 8000, 15500]);
    expect(policy.audio?.transcription?.default?.engine).toBe("whisper-local");
    expect(policy.audio?.transcription?.byTag?.meeting?.language).toBe("zh-CN");
    expect(policy.audioOutput?.default?.voice).toBe("alloy");
  });

  it("非法 yaml 文本抛 ResourcePolicyParseError", () => {
    expect(() => parseResourcePolicy("not: valid: yaml: :::")).toThrow(
      ResourcePolicyParseError,
    );
  });

  it("schema 不匹配抛 ResourcePolicyParseError", () => {
    expect(() =>
      parseResourcePolicy(`
        version: 1
        video:
          frameSampling:
            default:
              intervalSec: -1
        `),
    ).toThrow(ResourcePolicyParseError);
  });

  it("version 不为 1 抛错", () => {
    expect(() => parseResourcePolicy("version: 2\n")).toThrow(ResourcePolicyParseError);
  });

  it("空 object 不抛错（全部走 bundle default）", () => {
    const policy = parseResourcePolicy("version: 1\n");
    expect(policy).toEqual({ version: 1 });
  });
});

describe("resource-policy resolver", () => {
  const policy = parseResourcePolicy(YAML_OK);

  function entryWithPolicyTag(
    policyTag: string | undefined,
  ): Pick<WorkspaceResourceIndexEntry, "meta"> {
    return {
      meta: policyTag ? { policyTag } : undefined,
    };
  }

  it("video frameSampling：byTag 命中优先于 default", () => {
    const result = resolvePolicyForEntry(
      policy,
      entryWithPolicyTag("screen-recording"),
      "video",
      "frameSampling",
    );
    expect(result).toMatchObject({ intervalSec: 2, maxFrames: 300 });
  });

  it("video frameSampling：policyTag 未命中走 default", () => {
    const result = resolvePolicyForEntry(
      policy,
      entryWithPolicyTag("non-existent"),
      "video",
      "frameSampling",
    );
    expect(result).toMatchObject({ intervalSec: 10, maxFrames: 60, mode: "uniform" });
  });

  it("video frameSampling：meta.policyTag 缺失走 default", () => {
    const result = resolvePolicyForEntry(
      policy,
      { meta: undefined },
      "video",
      "frameSampling",
    );
    expect(result).toMatchObject({ intervalSec: 10 });
  });

  it("audio transcription：meeting 命中 byTag", () => {
    const result = resolvePolicyForEntry(
      policy,
      entryWithPolicyTag("meeting"),
      "audio",
      "transcription",
    );
    expect(result).toMatchObject({ engine: "whisper-local", language: "zh-CN" });
  });

  it("audio transcription：未命中 byTag → default", () => {
    const result = resolvePolicyForEntry(
      policy,
      entryWithPolicyTag("interview"),
      "audio",
      "transcription",
    );
    expect(result).toMatchObject({ engine: "whisper-local", language: "auto" });
  });

  it("audioOutput：default 命中", () => {
    const result = resolvePolicyForEntry(
      policy,
      entryWithPolicyTag(undefined),
      "audioOutput",
      undefined,
    );
    expect(result).toMatchObject({ voice: "alloy", format: "mp3" });
  });

  it("未配置 default 时返回 null（不抛错）", () => {
    const minimalPolicy = parseResourcePolicy("version: 1\n");
    const result = resolvePolicyForEntry(
      minimalPolicy,
      entryWithPolicyTag("anything"),
      "video",
      "frameSampling",
    );
    expect(result).toBeNull();
  });

  it("product-walkthrough explicit mode 保留 manualTimesMs", () => {
    const result = resolvePolicyForEntry(
      policy,
      entryWithPolicyTag("product-walkthrough"),
      "video",
      "frameSampling",
    );
    expect(result).toMatchObject({
      mode: "explicit",
      manualTimesMs: [0, 8000, 15500],
    });
  });
});