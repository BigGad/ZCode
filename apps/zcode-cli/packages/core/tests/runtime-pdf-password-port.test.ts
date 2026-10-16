import { describe, expect, it, vi } from "vitest";
import { createSessionId, PdfDocumentPortError, SessionEventType } from "@zcode/contracts";
import { PdfPasswordCache } from "../src/runtime/helpers/pdf-password-cache.js";
import {
  createPasswordAwarePdfDocumentPort,
  type PasswordAwarePdfDocumentPortDeps,
} from "../src/runtime/helpers/pdf-password-port.js";
import {
  PDF_PASSWORD_SKIP_OPTION_LABEL,
  buildPdfPasswordQuestion,
  requestPdfPasswordViaAskUserQuestion,
} from "../src/runtime/methods/pdf-password-prompt.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { PdfDocumentPageCountRequest, PdfDocumentPort } from "../src/runtime/deps.js";

const PASSWORD = "pw-12345";
const FILE_PATH = "/tmp/project/locked.pdf";

interface DecoratorHarness {
  cache: PdfPasswordCache;
  deps: PasswordAwarePdfDocumentPortDeps;
  getPageCount: ReturnType<typeof vi.fn>;
  renderPages: ReturnType<typeof vi.fn>;
  requestPassword: ReturnType<typeof vi.fn>;
}

function createInnerPort(options?: {
  alwaysFail?: boolean;
  /** 内层只认这个密码；任何其他密码（含错误注入密码）都按 password_protected 拒绝。 */
  correctPassword?: string;
}): {
  getPageCount: ReturnType<typeof vi.fn>;
  renderPages: ReturnType<typeof vi.fn>;
} {
  const correctPassword = options?.correctPassword ?? PASSWORD;
  const getPageCount = vi.fn(async (request: PdfDocumentPageCountRequest) => {
    if (request.password !== correctPassword) {
      throw new PdfDocumentPortError("password_protected", "locked");
    }
    if (options?.alwaysFail) {
      throw new PdfDocumentPortError("password_protected", "Incorrect password");
    }
    return 7;
  });
  const renderPages = vi.fn(async () => []);
  return { getPageCount, renderPages };
}

function createDecoratorHarness(
  askResult: Promise<string | undefined> | string | undefined,
  innerOptions?: { alwaysFail?: boolean },
  depsOverrides?: Partial<PasswordAwarePdfDocumentPortDeps>,
): DecoratorHarness {
  const cache = new PdfPasswordCache();
  const inner = createInnerPort(innerOptions);
  const requestPassword = vi.fn(() => Promise.resolve(askResult) as Promise<string | undefined>);
  const deps: PasswordAwarePdfDocumentPortDeps = {
    inner: inner as unknown as PdfDocumentPort,
    cache,
    normalizeKey: (filePath) => filePath,
    requestPassword: (...args) => requestPassword(...(args as [])),
    ...depsOverrides,
  };
  return {
    cache,
    deps,
    getPageCount: inner.getPageCount,
    renderPages: inner.renderPages,
    requestPassword,
  };
}

describe("PdfPasswordCache", () => {
  it("dedupes concurrent asks for the same key and shares one answer", async () => {
    const cache = new PdfPasswordCache();
    const deferreds: Array<(password: string | undefined) => void> = [];
    const ask = vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          deferreds.push(resolve);
        }),
    );
    const first = cache.runExclusive("a.pdf", ask);
    const second = cache.runExclusive("a.pdf", ask);
    deferreds[0]?.(PASSWORD);
    await expect(first).resolves.toBe(PASSWORD);
    await expect(second).resolves.toBe(PASSWORD);
    expect(ask).toHaveBeenCalledTimes(1);
    // 完成后并发窗口关闭：下次调用会重新 ask。
    const third = cache.runExclusive("a.pdf", ask);
    deferreds[1]?.(undefined);
    await expect(third).resolves.toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

describe("createPasswordAwarePdfDocumentPort", () => {
  it("passes through requests that already carry a password without asking", async () => {
    const harness = createDecoratorHarness(PASSWORD);
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const pageCount = await port.getPageCount(
      { filePath: FILE_PATH, password: PASSWORD, trace: { traceId: "t" } as never },
      { signal: undefined },
    );
    expect(pageCount).toBe(7);
    expect(harness.requestPassword).not.toHaveBeenCalled();
    // 直通不缓存：后续无密码请求仍会问询。
    expect(harness.cache.get(FILE_PATH)).toBeUndefined();
  });

  it("asks once, retries with the password and caches on success", async () => {
    const harness = createDecoratorHarness(PASSWORD);
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    expect(harness.getPageCount.mock.calls[0]![0]).not.toHaveProperty("password");
    expect(harness.getPageCount.mock.calls[1]![0]).toMatchObject({ password: PASSWORD });
    // 第二次调用命中缓存：不再问询。
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    expect(harness.requestPassword).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original error on Skip and asks again on the next call", async () => {
    const harness = createDecoratorHarness(undefined);
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).rejects.toMatchObject({
      code: "password_protected",
    });
    expect(harness.cache.get(FILE_PATH)).toBeUndefined();
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).rejects.toMatchObject({
      code: "password_protected",
    });
    expect(harness.requestPassword).toHaveBeenCalledTimes(2);
  });

  it("never caches a wrong password and surfaces the retry failure", async () => {
    const harness = createDecoratorHarness(PASSWORD, { alwaysFail: true });
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).rejects.toMatchObject({
      code: "password_protected",
    });
    expect(harness.cache.get(FILE_PATH)).toBeUndefined();
    // 下一次调用重新问询（错误密码不入缓存）。
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).rejects.toMatchObject({
      code: "password_protected",
    });
    expect(harness.requestPassword).toHaveBeenCalledTimes(2);
  });

  it("clears a stale cached password and re-asks when it stops working", async () => {
    const harness = createDecoratorHarness(PASSWORD);
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    // 模拟文件换了密码：缓存密码继续失败。
    harness.getPageCount.mockImplementation(async (request: PdfDocumentPageCountRequest) => {
      if (request.password !== "new-pw") {
        throw new PdfDocumentPortError("password_protected", "locked");
      }
      return 7;
    });
    harness.requestPassword.mockReturnValue(Promise.resolve("new-pw"));
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    // 首次成功 + 缓存失效后重问各一次。
    expect(harness.requestPassword).toHaveBeenCalledTimes(2);
    expect(harness.cache.get(FILE_PATH)).toBe("new-pw");
  });

  it("lets non-password errors pass through without asking", async () => {
    const harness = createDecoratorHarness(PASSWORD);
    harness.getPageCount.mockRejectedValue(new PdfDocumentPortError("corrupted", "broken pdf"));
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    await expect(
      port.getPageCount({ filePath: FILE_PATH, trace: { traceId: "t" } as never }),
    ).rejects.toMatchObject({ code: "corrupted" });
    expect(harness.requestPassword).not.toHaveBeenCalled();
  });
});

describe("createPasswordAwarePdfDocumentPort with staticPassword (--pdf-password)", () => {
  it("tries the CLI static password before asking, caches it on success", async () => {
    const harness = createDecoratorHarness(PASSWORD, undefined, { staticPassword: PASSWORD });
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    // 静态密码成功：不走问询；按既有规则入缓存，后续调用直接命中缓存。
    expect(harness.requestPassword).not.toHaveBeenCalled();
    expect(harness.cache.get(FILE_PATH)).toBe(PASSWORD);
    const callsBefore = harness.getPageCount.mock.calls.length;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    // 装饰器每次先裸跑试探（无密码），缓存命中后带密码重跑。
    expect(harness.getPageCount.mock.calls[callsBefore]![0]).not.toHaveProperty("password");
    expect(harness.getPageCount.mock.calls[callsBefore + 1]![0]).toMatchObject({
      password: PASSWORD,
    });
  });

  it("falls back to asking when the CLI static password is wrong", async () => {
    const onStaticPasswordRejected = vi.fn();
    const harness = createDecoratorHarness(PASSWORD, undefined, {
      staticPassword: "wrong-pw",
      onStaticPasswordRejected,
    });
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    // 静态密码失败不缓存、不阻断：落到问询并成功。
    expect(harness.requestPassword).toHaveBeenCalledTimes(1);
    expect(harness.cache.get(FILE_PATH)).toBe(PASSWORD);
  });

  it("notifies onStaticPasswordRejected with the path (never the password) when the CLI password is wrong", async () => {
    const onStaticPasswordRejected = vi.fn();
    const harness = createDecoratorHarness(undefined, undefined, {
      staticPassword: "wrong-pw",
      onStaticPasswordRejected,
    });
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).rejects.toMatchObject({
      code: "password_protected",
    });
    expect(onStaticPasswordRejected).toHaveBeenCalledTimes(1);
    expect(onStaticPasswordRejected).toHaveBeenCalledWith(FILE_PATH);
  });

  it("does not notify onStaticPasswordRejected when the CLI password succeeds", async () => {
    const onStaticPasswordRejected = vi.fn();
    const harness = createDecoratorHarness(undefined, undefined, {
      staticPassword: PASSWORD,
      onStaticPasswordRejected,
    });
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    expect(onStaticPasswordRejected).not.toHaveBeenCalled();
  });

  it("surfaces password_protected when the static password is wrong and no ask face exists (headless)", async () => {
    const harness = createDecoratorHarness(undefined, undefined, { staticPassword: "wrong-pw" });
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).rejects.toMatchObject({
      code: "password_protected",
    });
    expect(harness.requestPassword).toHaveBeenCalledTimes(1);
    expect(harness.cache.get(FILE_PATH)).toBeUndefined();
  });

  it("prefers the cache over the CLI static password", async () => {
    const harness = createDecoratorHarness(PASSWORD, undefined, { staticPassword: "wrong-pw" });
    harness.cache.set(FILE_PATH, PASSWORD);
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const trace = { traceId: "t" } as never;
    await expect(port.getPageCount({ filePath: FILE_PATH, trace })).resolves.toBe(7);
    // 缓存命中：静态密码与问询都不触发；calls[0] 是无密码试探，calls[1] 才是缓存密码重跑。
    expect(harness.requestPassword).not.toHaveBeenCalled();
    expect(harness.getPageCount.mock.calls[1]![0]).toMatchObject({ password: PASSWORD });
  });

  it("does not use the static password when the request already carries one", async () => {
    const harness = createDecoratorHarness(PASSWORD, undefined, { staticPassword: "wrong-pw" });
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    const pageCount = await port.getPageCount(
      { filePath: FILE_PATH, password: PASSWORD, trace: { traceId: "t" } as never },
      { signal: undefined },
    );
    expect(pageCount).toBe(7);
    expect(harness.requestPassword).not.toHaveBeenCalled();
  });

  it("rethrows non-password errors from the static attempt without asking", async () => {
    const harness = createDecoratorHarness(PASSWORD, undefined, { staticPassword: PASSWORD });
    const port = createPasswordAwarePdfDocumentPort(harness.deps);
    harness.getPageCount.mockRejectedValue(new PdfDocumentPortError("corrupted", "broken pdf"));
    await expect(
      port.getPageCount({ filePath: FILE_PATH, trace: { traceId: "t" } as never }),
    ).rejects.toMatchObject({ code: "corrupted" });
    expect(harness.requestPassword).not.toHaveBeenCalled();
  });
});

describe("requestPdfPasswordViaAskUserQuestion", () => {
  function createRuntimeHarness(brokerResult: unknown) {
    const events: Array<{ type: SessionEventType; payload: unknown }> = [];
    const broker = { requestPermission: vi.fn(async () => brokerResult) };
    const runtime = {
      sessionId: createSessionId("pdf-password"),
      getMode: () => "build",
      permissionBroker: broker,
      emitPermissionRequest: vi.fn(async () => {}),
      createEvent: (type: SessionEventType, payload: unknown) => ({
        id: `event-${events.length + 1}`,
        type,
        payload,
      }),
      appendEvent: vi.fn(async (event: { type: SessionEventType; payload: unknown }) => {
        events.push({ type: event.type, payload: event.payload });
      }),
    } as unknown as AgentRuntimeInternal;
    return { broker, events, runtime };
  }

  function answerModify(answer: string) {
    return (request: { input: { questions: Array<{ question: string }> } }) => ({
      decision: "modify",
      modifiedInput: { answers: { [request.input.questions[0]!.question]: answer } },
    });
  }

  it("extracts the broker answer as the password and names the file in the question", async () => {
    const { broker, runtime } = createRuntimeHarness(null);
    broker.requestPermission.mockImplementation(answerModify(PASSWORD));
    const password = await requestPdfPasswordViaAskUserQuestion.call(
      runtime,
      { filePath: FILE_PATH, trace: { traceId: "t" } as never },
      { traceId: "t" } as never,
    );
    expect(password).toBe(PASSWORD);
    const request = broker.requestPermission.mock.calls[0]![0] as {
      input: { questions: Array<{ question: string; options: Array<{ label: string }> }> };
      ruleId: string;
    };
    expect(request.ruleId).toBe("pdf-password-unlock");
    expect(request.input.questions[0]!.question).toBe(buildPdfPasswordQuestion(FILE_PATH));
    expect(request.input.questions[0]!.options[0]!.label).toBe(PDF_PASSWORD_SKIP_OPTION_LABEL);
  });

  it("never persists the password in permission events or broker input", async () => {
    const { broker, events, runtime } = createRuntimeHarness(null);
    broker.requestPermission.mockImplementation(answerModify(PASSWORD));
    await requestPdfPasswordViaAskUserQuestion.call(
      runtime,
      { filePath: FILE_PATH, trace: { traceId: "t" } as never },
      { traceId: "t" } as never,
    );
    const requestInput = broker.requestPermission.mock.calls[0]![0] as { input: unknown };
    expect(JSON.stringify(requestInput.input)).not.toContain(PASSWORD);
    expect(events).toHaveLength(1);
    const resolvedEvent = events[0]!;
    expect(resolvedEvent.type).toBe(SessionEventType.PermissionResolved);
    expect(JSON.stringify(resolvedEvent.payload)).not.toContain(PASSWORD);
    expect(resolvedEvent.payload).toEqual({ toolCallId: expect.any(String), decision: "allow" });
  });

  it("treats the Skip option and empty answers as no password", async () => {
    for (const answer of [PDF_PASSWORD_SKIP_OPTION_LABEL, "   "]) {
      const { broker, runtime } = createRuntimeHarness(null);
      broker.requestPermission.mockImplementation(answerModify(answer));
      await expect(
        requestPdfPasswordViaAskUserQuestion.call(
          runtime,
          { filePath: FILE_PATH, trace: { traceId: "t" } as never },
          { traceId: "t" } as never,
        ),
      ).resolves.toBeUndefined();
    }
  });
});
