import type { ModelSelection, PersonalProviderConfigRepository } from "@zcode/provider";
import type { CapabilityModelSelections } from "@zcode/shared/model-selection";

export interface NodeModelSelectionConfigRepositoryOptions {
  readonly personalRepository: PersonalProviderConfigRepository;
}

/** 默认选择只是 Personal 文件的一个字段；IO、锁和失效通知由同一个 Repository 拥有。 */
export class NodeModelSelectionConfigRepository {
  readonly #personal: PersonalProviderConfigRepository;
  readonly #subscriptions = new Set<() => void>();
  #disposed = false;

  constructor(options: NodeModelSelectionConfigRepositoryOptions) {
    this.#personal = options.personalRepository;
  }

  async read(): Promise<ModelSelection | undefined> {
    this.#assertNotDisposed();
    return (await this.#personal.read()).defaultModelSelection;
  }

  /**
   * 能力模型选择同样来自 Personal 文件的另一个字段（capability-model-selection.md）。
   * 与默认选择共用一份文件，因此也共用同一次读取的 IO 与锁。
   */
  async readCapabilitySelections(): Promise<CapabilityModelSelections | undefined> {
    this.#assertNotDisposed();
    return (await this.#personal.read()).capabilityModelSelections;
  }

  async saveConfiguredDefault(
    selection: ModelSelection | undefined,
  ): Promise<ModelSelection | undefined> {
    this.#assertNotDisposed();
    const snapshot = await this.#personal.update((current) => ({
      ...current,
      defaultModelSelection: selection,
    }));
    return snapshot.defaultModelSelection;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    const unsubscribe = this.#personal.onDidChange(listener);
    const dispose = () => {
      this.#subscriptions.delete(dispose);
      unsubscribe();
    };
    this.#subscriptions.add(dispose);
    return dispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#subscriptions) dispose();
    // 不销毁共享 Personal Repository；它仍由 Config Runtime 生命周期管理。
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeModelSelectionConfigRepository 已 dispose");
  }
}
