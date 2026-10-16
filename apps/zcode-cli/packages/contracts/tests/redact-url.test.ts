import { describe, expect, it } from "vitest";
import { redactUrlCredentials, redactUrlString } from "../src/network/redact-url.js";

describe("redactUrlCredentials", () => {
  it("剥除 username 与 password", () => {
    const url = new URL("rtsp://user:secret@cam.local:554/live");
    expect(redactUrlCredentials(url)).toBe("rtsp://cam.local:554/live");
  });

  it("只含 username 时同样剥除", () => {
    const url = new URL("rtsp://user@cam.local/live");
    expect(redactUrlCredentials(url)).toBe("rtsp://cam.local/live");
  });

  it("无凭据时保持不变（幂等）", () => {
    const url = new URL("rtsp://cam.local:554/live");
    const once = redactUrlCredentials(url);
    expect(once).toBe("rtsp://cam.local:554/live");
    expect(redactUrlCredentials(new URL(once))).toBe(once);
  });
});

describe("redactUrlString", () => {
  it("可解析 URL：剥除 userinfo", () => {
    expect(redactUrlString("rtsp://user:secret@cam.local:554/live")).toBe(
      "rtsp://cam.local:554/live",
    );
  });

  it("不可解析输入退回正则剥除 userinfo 前缀", () => {
    expect(redactUrlString("weird-scheme://user:secret@host/path")).toBe("weird-scheme://host/path");
  });

  it("无凭据字符串原样返回", () => {
    expect(redactUrlString("rtsp://cam.local/live")).toBe("rtsp://cam.local/live");
  });
});
