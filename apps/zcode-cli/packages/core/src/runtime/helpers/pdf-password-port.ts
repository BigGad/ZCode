import { PdfDocumentPortError } from "@zcode/contracts";
import type { PdfDocumentPageCountRequest, PdfDocumentPort, TraceContext } from "../deps.js";
import type { PdfPasswordCache } from "./pdf-password-cache.js";

/**
 * PDF 密码统一通道的端口装饰器（见 message-attachments.md 同日章节）。
 *
 * 包装点在 AgentRuntime 构造器内，覆盖 Read 工具、两条附件链路与子 runtime；
 * workflow-facade / script-workflow-bridge 故意持有原始 port：后台上下文没有
 * 交互面，密码 PDF 直接 password_protected 失败属设计行为，不弹窗。
 *
 * 解锁语义：请求已带密码 → 直通。password_protected 且未带密码时：
 * 缓存密码先试（失败即清缓存）→ CLI 注入密码（--pdf-password，可选）→
 * 经 AskUserQuestion 问一次（同文件并发去重）→
 * 带密码重试一次 → 成功缓存、失败不缓存（错误密码永不入缓存）；
 * Skip / broker 拒绝 → 原样抛错。
 */
export interface PasswordAwarePdfDocumentPortDeps {
  inner: PdfDocumentPort;
  cache: PdfPasswordCache;
  /**
   * CLI 无头注入的全局密码（--pdf-password，单值适用于所有文件）；
   * undefined/空 = 未提供。只在 password_protected 后尝试，成功入缓存，失败落到问询。
   */
  staticPassword?: string;
  /**
   * CLI 注入密码验证失败时的可观测回调（只带路径，绝不携带密码）：
   * 让调用方日志能区分「密码错误」与「未提供密码」——批处理场景密码错会被
   * 当作锁文件降级，没有这条信号就会静默漏判。
   */
  onStaticPasswordRejected?: (filePath: string) => void;
  normalizeKey: (filePath: string) => string;
  requestPassword: (
    request: PdfDocumentPageCountRequest,
    traceContext: TraceContext,
    abortSignal?: AbortSignal,
  ) => Promise<string | undefined>;
}

export function createPasswordAwarePdfDocumentPort(
  deps: PasswordAwarePdfDocumentPortDeps,
): PdfDocumentPort {
  return {
    getPageCount(request, options) {
      return withPasswordUnlock(deps, request, options?.signal, (password) =>
        deps.inner.getPageCount(password ? { ...request, password } : request, options),
      );
    },
    renderPages(request, options) {
      return withPasswordUnlock(deps, request, options?.signal, (password) =>
        deps.inner.renderPages(password ? { ...request, password } : request, options),
      );
    },
    analyzeLayout(request, options) {
      // ⚠️ **原生版面分析与读页同属「要打开 PDF」的动作** ⇒ 同一套解锁语义
      // （缓存密码 → CLI 注入密码 → 问询）。
      return withPasswordUnlock(deps, request, options?.signal, (password) =>
        deps.inner.analyzeLayout(password ? { ...request, password } : request, options),
      );
    },
    decryptToFile(request, options) {
      // ⚠️ **解密不走问询解锁**：请求里**必定**已经带了密码（CLI 的 `--pdf-password`），
      // 问询拿到的是「读一页」的密码，语义不同；这里只做直通委托。
      return deps.inner.decryptToFile(request, options);
    },
  };
}

async function withPasswordUnlock<T>(
  deps: PasswordAwarePdfDocumentPortDeps,
  request: PdfDocumentPageCountRequest,
  signal: AbortSignal | undefined,
  run: (password?: string) => Promise<T>,
): Promise<T> {
  // 请求已带密码（如旧链路显式注入）→ 直通不问询。
  if (request.password) return run(request.password);
  try {
    return await run();
  } catch (error) {
    if (!isPasswordProtectedError(error)) throw error;
    const key = deps.normalizeKey(request.filePath);
    const cached = deps.cache.get(key);
    if (cached !== undefined) {
      try {
        return await run(cached);
      } catch (retryError) {
        if (!isPasswordProtectedError(retryError)) throw retryError;
        // 缓存密码已失效（文件可能换了密码）：清缓存后落到问询，绝不缓存错误密码。
        deps.cache.clear(key);
      }
    }
    // CLI 注入密码与问询同锁（runExclusive）：同文件并发去重共用一次尝试。
    // 静态密码成功走既有「重试 → 成功缓存」路径；失败（错误密码）不入缓存、
    // 不阻断问询——无头下问询被 deny broker 拒绝即原样抛首错，交互下降级为弹窗。
    const password = await deps.cache.runExclusive(key, async () => {
      if (deps.staticPassword) {
        try {
          await run(deps.staticPassword);
          return deps.staticPassword;
        } catch (staticError) {
          if (!isPasswordProtectedError(staticError)) throw staticError;
          // 只报「CLI 密码被拒」这一事实，错误密码本身绝不进日志。
          deps.onStaticPasswordRejected?.(request.filePath);
        }
      }
      return deps.requestPassword(request, request.trace, signal);
    });
    // Skip / broker 拒绝：原样抛出首次错误，调用方按既有占位符/错误码降级。
    if (password === undefined) throw error;
    const result = await run(password);
    // 解锁成功才缓存；上一行失败（含错误密码）不会执行到这里。
    deps.cache.set(key, password);
    return result;
  }
}

function isPasswordProtectedError(error: unknown): error is PdfDocumentPortError {
  return error instanceof PdfDocumentPortError && error.code === "password_protected";
}
