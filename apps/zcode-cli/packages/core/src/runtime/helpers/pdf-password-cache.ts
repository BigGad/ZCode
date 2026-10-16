/**
 * PDF 解锁密码的内存缓存（密码统一通道的唯一所有者）。
 *
 * 生命周期 = runtime 生命周期：纯 Map、从不序列化、不落盘、不进事件/元数据/日志
 * （见 message-attachments.md「PDF 密码统一通道与阅读进度」节）。
 * key = 规范化绝对路径（由构造方注入 normalizeKey），因此无需 workspaceKey/sha256。
 */
export class PdfPasswordCache {
  private readonly passwords = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | undefined>>();

  get(key: string): string | undefined {
    return this.passwords.get(key);
  }

  /** 仅在解锁成功后调用；错误密码永不入缓存。 */
  set(key: string, password: string): void {
    this.passwords.set(key, password);
  }

  /** 缓存密码验证失败时清除（文件可能已换密码），下次重新询问。 */
  clear(key: string): void {
    this.passwords.delete(key);
  }

  /**
   * 同一文件的并发问询去重：首个调用者发起 ask，其余共享同一次应答。
   * 失败（含 Skip）不进缓存，等待方也拿到 undefined。
   */
  runExclusive(key: string, ask: () => Promise<string | undefined>): Promise<string | undefined> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = ask()
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, task);
    return task;
  }
}
