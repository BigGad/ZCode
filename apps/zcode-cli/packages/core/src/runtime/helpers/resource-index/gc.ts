import type { Logger, TraceContext, WorkspaceResourceIndexPort } from "@zcode/contracts";

/**
 * Resource Index GC + session lifecycle bookkeeping。
 *
 * Phase 2.5 提供最小可行版：
 * - tick(): 周期性扫一次 ref_count == 0 的 entries，调用 removeIfNotOrphaned 清理。
 * - registerSessionReference(): session 引用 entry 时调用，delta=+1。
 * - unregisterSessionReference(): session 释放 entry 引用时调用，delta=-1。
 * - closeSession(): session 整体关闭时一次性释放所有该 session 注册的引用。
 *
 * session 生命周期自动 wiring 留到 Phase 2.5b：当前版本由 attachment resolver / fork /
 * rewind 代码面显式调用本 helper，不内置 session-event hook。
 */
export interface CreateResourceIndexGCHelperOptions {
  port: WorkspaceResourceIndexPort;
  /** workspace 单一 key，与其它 workspace 隔离。 */
  workspaceKey: string;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
}

export interface ResourceIndexGCHelper {
  /** session 引用 entry（fork child resume 等）；返回完成后实际引用的 id 列表。 */
  registerSessionReference(sessionId: string, resourceIds: string[]): Promise<void>;
  /** session 释放 entry 引用（rewind 越过 attachment 等）。 */
  unregisterSessionReference(sessionId: string, resourceIds: string[]): Promise<void>;
  /** session 关闭；释放该 session 全部已注册引用并清空本地记录。 */
  closeSession(sessionId: string): Promise<void>;
  /** 周期性 GC 一次：扫 ref_count == 0 entries 并删除。 */
  tick(): Promise<{ removed: string[] }>;
}

export function createResourceIndexGCHelper(
  options: CreateResourceIndexGCHelperOptions,
): ResourceIndexGCHelper {
  const logger = options.logger ?? createNoopLogger();
  /** sessionId → 该 session 注册过的 entry id 集合（用于 closeSession 一次性释放）。 */
  const sessionRegistry = new Map<string, Set<string>>();

  function logDebug(message: string, fields?: Record<string, unknown>): void {
    logger.debug(message, fields);
  }
  function logWarn(message: string, fields?: Record<string, unknown>): void {
    logger.warn(message, fields);
  }

  async function registerSessionReference(
    sessionId: string,
    resourceIds: string[],
  ): Promise<void> {
    if (resourceIds.length === 0) return;
    const set = sessionRegistry.get(sessionId) ?? new Set<string>();
    const newIds: string[] = [];
    for (const id of resourceIds) {
      if (!set.has(id)) {
        set.add(id);
        newIds.push(id);
      }
    }
    if (newIds.length > 0) {
      sessionRegistry.set(sessionId, set);
      await options.port.incrementReferences({
        workspaceKey: options.workspaceKey,
        ids: newIds,
        delta: 1,
      });
      logDebug("resource_index_gc.registerSessionReference", {
        sessionId,
        newIdsCount: newIds.length,
      });
    }
  }

  async function unregisterSessionReference(
    sessionId: string,
    resourceIds: string[],
  ): Promise<void> {
    if (resourceIds.length === 0) return;
    const set = sessionRegistry.get(sessionId);
    const targetIds: string[] = [];
    for (const id of resourceIds) {
      if (set?.has(id)) {
        set.delete(id);
        targetIds.push(id);
      }
    }
    if (targetIds.length > 0) {
      await options.port.incrementReferences({
        workspaceKey: options.workspaceKey,
        ids: targetIds,
        delta: -1,
      });
      logDebug("resource_index_gc.unregisterSessionReference", {
        sessionId,
        targetIdsCount: targetIds.length,
      });
    }
  }

  async function closeSession(sessionId: string): Promise<void> {
    const set = sessionRegistry.get(sessionId);
    if (!set || set.size === 0) {
      sessionRegistry.delete(sessionId);
      return;
    }
    const ids = Array.from(set);
    sessionRegistry.delete(sessionId);
    try {
      await options.port.incrementReferences({
        workspaceKey: options.workspaceKey,
        ids,
        delta: -1,
      });
      logDebug("resource_index_gc.closeSession", { sessionId, idsCount: ids.length });
    } catch (error) {
      logWarn("resource_index_gc.closeSession_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function tick(): Promise<{ removed: string[] }> {
    // 全局扫一遍所有 entries；GC 不传 ids 列表；removeIfOrphaned 内部按 ref_count==0 过滤。
    try {
      const queryResult = await options.port.query({
        workspaceKey: options.workspaceKey,
        limit: 1000,
      });
      if (queryResult.entries.length === 0) return { removed: [] };
      const ids = queryResult.entries.map((e) => e.id);
      const result = await options.port.removeIfNotOrphaned({
        workspaceKey: options.workspaceKey,
        ids,
      });
      logDebug("resource_index_gc.tick", {
        scannedCount: ids.length,
        removedCount: result.removed.length,
      });
      return result;
    } catch (error) {
      logWarn("resource_index_gc.tick_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { removed: [] };
    }
  }

  return {
    registerSessionReference,
    unregisterSessionReference,
    closeSession,
    tick,
  };
}

function createNoopLogger(): Pick<Logger, "debug" | "info" | "warn" | "error"> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * 占位 helper：Phase 2.5b 把这个钩子接到 session-event 流，自动驱动 register /
 * unregister / close。当前保留接口以避免后续 Phase 改动跨多文件。
 */
export interface SessionLifecycleHooks {
  onForkChildResume?(sessionId: string, parentResourceIds: string[]): Promise<void>;
  onRewindOverAttachment?(sessionId: string, removedResourceIds: string[]): Promise<void>;
  onSessionClose?(sessionId: string): Promise<void>;
}

export type { TraceContext };