import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  WorkspaceResourceIndexPortError,
  type WorkspaceResourceIndexEntry,
  type WorkspaceResourceIndexPort,
  type WorkspaceResourceIndexQuery,
  type WorkspaceResourceIndexQueryResult,
  type WorkspaceResourceVariant,
} from "@zcode/contracts";

export interface WorkspaceResourceIndexLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface CreateWorkspaceResourceIndexOptions {
  /** SQLite 文件路径；父目录不存在则创建。 */
  dbPath: string;
  logger?: WorkspaceResourceIndexLogger;
}

const WORKSPACE_RESOURCE_INDEX_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS resource_entries (
  id TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  filename TEXT,
  source_origin TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_referenced_at INTEGER,
  tags TEXT,
  meta TEXT,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_entries_workspace_kind
  ON resource_entries(workspace_identity, kind);
CREATE INDEX IF NOT EXISTS idx_entries_workspace_updated
  ON resource_entries(workspace_identity, updated_at DESC);

CREATE TABLE IF NOT EXISTS resource_variants (
  entry_id TEXT NOT NULL REFERENCES resource_entries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT,
  artifact_uri TEXT,
  path TEXT,
  meta TEXT,
  PRIMARY KEY (entry_id, kind)
);

CREATE TABLE IF NOT EXISTS resource_references (
  entry_id TEXT NOT NULL REFERENCES resource_entries(id) ON DELETE CASCADE,
  ref_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id)
);
`;

/**
 * workspace 维度跨 session 资源库的 Node SQLite adapter。
 * 一个 workspace 一个 SQLite 文件；workspaceKey = workspaceIdentity || workspacePath。
 */
export function createWorkspaceResourceIndexPort(
  options: CreateWorkspaceResourceIndexOptions,
): WorkspaceResourceIndexPort {
  mkdirSync(dirname(options.dbPath), { recursive: true });
  const db = new DatabaseSync(options.dbPath);
  db.exec("pragma journal_mode = wal");
  db.exec("pragma foreign_keys = on");
  db.exec(WORKSPACE_RESOURCE_INDEX_SCHEMA_V1);

  function logDebug(message: string, fields?: Record<string, unknown>): void {
    options.logger?.debug(message, fields);
  }

  function validateWorkspaceKey(workspaceKey: string): void {
    if (typeof workspaceKey !== "string" || workspaceKey.length === 0) {
      throw new WorkspaceResourceIndexPortError(
        "workspace_key_invalid",
        "workspace key must be a non-empty string (workspaceIdentity trimmed or workspacePath)",
      );
    }
  }

  function readEntry(rowId: string): WorkspaceResourceIndexEntry | undefined {
    const row = db
      .prepare(
        `SELECT id, workspace_identity, workspace_path, kind, title, filename,
                source_origin, added_at, updated_at, last_referenced_at, tags, meta
         FROM resource_entries WHERE id = ?`,
      )
      .get(rowId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const variants = readVariants(rowId);
    const refCount = readReferenceCount(rowId);
    return rowToEntry(row, variants, refCount);
  }

  function readVariants(rowId: string): WorkspaceResourceVariant[] {
    const rows = db
      .prepare(
        `SELECT kind, mime, bytes, sha256, artifact_uri, path, meta
         FROM resource_variants WHERE entry_id = ? ORDER BY kind`,
      )
      .all(rowId) as Record<string, unknown>[];
    return rows.map(rowToVariant);
  }

  function readReferenceCount(rowId: string): number {
    const row = db
      .prepare("SELECT ref_count FROM resource_references WHERE entry_id = ?")
      .get(rowId) as { ref_count: number } | undefined;
    return row?.ref_count ?? 0;
  }

  function insertOrReplaceEntry(entry: WorkspaceResourceIndexEntry): void {
    db.prepare(
      `INSERT INTO resource_entries (
         id, workspace_identity, workspace_path, kind, title, filename,
         source_origin, added_at, updated_at, last_referenced_at, tags, meta
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_identity = excluded.workspace_identity,
         workspace_path = excluded.workspace_path,
         kind = excluded.kind,
         title = excluded.title,
         filename = excluded.filename,
         source_origin = excluded.source_origin,
         updated_at = excluded.updated_at,
         last_referenced_at = excluded.last_referenced_at,
         tags = excluded.tags,
         meta = excluded.meta`,
    ).run(
      entry.id,
      entry.workspaceIdentity,
      entry.workspacePath,
      entry.kind,
      entry.title,
      entry.filename ?? null,
      entry.sourceOrigin,
      entry.addedAt,
      entry.updatedAt,
      entry.lastReferencedAt ?? null,
      JSON.stringify(entry.tags ?? null),
      JSON.stringify(entry.meta ?? null),
    );
  }

  function replaceVariants(entry: WorkspaceResourceIndexEntry): void {
    db.prepare("DELETE FROM resource_variants WHERE entry_id = ?").run(entry.id);
    const insertVariant = db.prepare(
      `INSERT INTO resource_variants (
         entry_id, kind, mime, bytes, sha256, artifact_uri, path, meta
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const variant of entry.variants) {
      insertVariant.run(
        entry.id,
        variant.kind,
        variant.mime,
        variant.bytes,
        variant.sha256 ?? null,
        variant.artifactUri ?? null,
        variant.path ?? null,
        JSON.stringify(variant.meta ?? null),
      );
    }
  }

  function ensureReferenceRow(rowId: string, references: number): void {
    db.prepare(
      `INSERT INTO resource_references (entry_id, ref_count)
       VALUES (?, ?)
       ON CONFLICT(entry_id) DO NOTHING`,
    ).run(rowId, references);
  }

  return {
    async upsert(entry, opts) {
      opts?.signal?.throwIfAborted();
      validateWorkspaceKey(entry.workspaceIdentity);
      try {
        db.exec("begin immediate");
        try {
          insertOrReplaceEntry(entry);
          replaceVariants(entry);
          ensureReferenceRow(entry.id, entry.references);
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } catch (error) {
        if (error instanceof WorkspaceResourceIndexPortError) throw error;
        throw new WorkspaceResourceIndexPortError(
          "resource_index_write_conflict",
          `upsert failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      logDebug("workspace_resource_index.upsert", {
        id: entry.id,
        kind: entry.kind,
        workspaceKey: entry.workspaceIdentity || entry.workspacePath,
      });
      return readEntry(entry.id) ?? entry;
    },

    async getById(workspaceKey, id, opts) {
      opts?.signal?.throwIfAborted();
      validateWorkspaceKey(workspaceKey);
      const row = db
        .prepare(
          `SELECT id, workspace_identity FROM resource_entries
           WHERE id = ? AND (workspace_identity = ? OR workspace_path = ?)`,
        )
        .get(id, workspaceKey, workspaceKey) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return readEntry(id);
    },

    async query(req, opts) {
      opts?.signal?.throwIfAborted();
      validateWorkspaceKey(req.workspaceKey);
      const conditions: string[] = [
        "(workspace_identity = ? OR workspace_path = ?)",
      ];
      const params: (string | number)[] = [req.workspaceKey, req.workspaceKey];
      if (req.kinds && req.kinds.length > 0) {
        const placeholders = req.kinds.map(() => "?").join(",");
        conditions.push(`kind IN (${placeholders})`);
        params.push(...req.kinds);
      }
      if (req.tags && req.tags.length > 0) {
        // tags 是 JSON array；用 LIKE 在 entry row 上做子串匹配（精度足够，workspace 单租户）。
        const tagConditions = req.tags.map(() => `tags LIKE ?`).join(" OR ");
        conditions.push(`(${tagConditions})`);
        for (const tag of req.tags) {
          params.push(`%"${escapeJsonString(tag)}"%`);
        }
      }
      if (req.textSearch && req.textSearch.length > 0) {
        const escaped = `%${escapeLikePattern(req.textSearch)}%`;
        conditions.push("(title LIKE ? OR filename LIKE ? OR tags LIKE ?)");
        params.push(escaped, escaped, escaped);
      }
      const limit = req.limit ?? 100;
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `
        SELECT id, workspace_identity, workspace_path, kind, title, filename,
               source_origin, added_at, updated_at, last_referenced_at, tags, meta
        FROM resource_entries
        ${whereClause}
        ORDER BY updated_at DESC
        LIMIT ?
      `;
      params.push(limit + 1); // 取 limit+1 以判定 nextCursor
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      const hasMore = rows.length > limit;
      const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => {
        const id = row.id as string;
        return rowToEntry(row, readVariants(id), readReferenceCount(id));
      });
      const result: WorkspaceResourceIndexQueryResult = { entries };
      if (hasMore && entries.length > 0) {
        result.nextCursor = entries[entries.length - 1]?.id;
      }
      return result;
    },

    async addVariant(req, opts) {
      opts?.signal?.throwIfAborted();
      validateWorkspaceKey(req.workspaceKey);
      const existing = await this.getById(req.workspaceKey, req.id, opts);
      if (!existing) {
        throw new WorkspaceResourceIndexPortError(
          "resource_not_found",
          `entry ${req.id} not found in workspace ${req.workspaceKey}`,
        );
      }
      try {
        db.exec("begin immediate");
        try {
          const insertVariant = db.prepare(
            `INSERT INTO resource_variants (
               entry_id, kind, mime, bytes, sha256, artifact_uri, path, meta
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(entry_id, kind) DO UPDATE SET
               mime = excluded.mime,
               bytes = excluded.bytes,
               sha256 = excluded.sha256,
               artifact_uri = excluded.artifact_uri,
               path = excluded.path,
               meta = excluded.meta`,
          );
          insertVariant.run(
            req.id,
            req.variant.kind,
            req.variant.mime,
            req.variant.bytes,
            req.variant.sha256 ?? null,
            req.variant.artifactUri ?? null,
            req.variant.path ?? null,
            JSON.stringify(req.variant.meta ?? null),
          );
          db.prepare("UPDATE resource_entries SET updated_at = ? WHERE id = ?").run(
            Date.now(),
            req.id,
          );
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } catch (error) {
        if (error instanceof WorkspaceResourceIndexPortError) throw error;
        throw new WorkspaceResourceIndexPortError(
          "resource_index_write_conflict",
          `addVariant failed for ${req.id}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      logDebug("workspace_resource_index.addVariant", {
        id: req.id,
        variantKind: req.variant.kind,
      });
      return (await this.getById(req.workspaceKey, req.id, opts)) ?? existing;
    },

    async incrementReferences(req, opts) {
      opts?.signal?.throwIfAborted();
      validateWorkspaceKey(req.workspaceKey);
      if (req.delta === 0 || req.ids.length === 0) return;
      try {
        db.exec("begin immediate");
        try {
          for (const id of req.ids) {
            db.prepare(
              `INSERT INTO resource_references (entry_id, ref_count)
               VALUES (?, ?)
               ON CONFLICT(entry_id) DO UPDATE SET ref_count = ref_count + ?`,
            ).run(id, req.delta, req.delta);
            // 不允许负值；clamp 到 0
            db.prepare(
              `UPDATE resource_references SET ref_count = MAX(0, ref_count) WHERE entry_id = ?`,
            ).run(id);
          }
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } catch (error) {
        if (error instanceof WorkspaceResourceIndexPortError) throw error;
        throw new WorkspaceResourceIndexPortError(
          "resource_index_write_conflict",
          `incrementReferences failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },

    async removeIfNotOrphaned(req, opts) {
      opts?.signal?.throwIfAborted();
      validateWorkspaceKey(req.workspaceKey);
      const removed: string[] = [];
      try {
        db.exec("begin immediate");
        try {
          const select = db.prepare(
            `SELECT r.entry_id AS id, r.ref_count AS ref_count
             FROM resource_references r
             INNER JOIN resource_entries e ON e.id = r.entry_id
             WHERE r.entry_id = ?
               AND (e.workspace_identity = ? OR e.workspace_path = ?)
               AND r.ref_count = 0`,
          );
          const deleteEntry = db.prepare("DELETE FROM resource_entries WHERE id = ?");
          for (const id of req.ids) {
            const row = select.get(id, req.workspaceKey, req.workspaceKey) as
              | { id: string; ref_count: number }
              | undefined;
            if (!row) continue;
            // ON DELETE CASCADE 自动清掉 variants / references
            deleteEntry.run(id);
            removed.push(id);
          }
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } catch (error) {
        if (error instanceof WorkspaceResourceIndexPortError) throw error;
        throw new WorkspaceResourceIndexPortError(
          "resource_index_write_conflict",
          `removeIfNotOrphaned failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      logDebug("workspace_resource_index.removeIfNotOrphaned", { removedCount: removed.length });
      return { removed };
    },
  };
}

function rowToEntry(
  row: Record<string, unknown>,
  variants: WorkspaceResourceVariant[],
  references: number,
): WorkspaceResourceIndexEntry {
  return {
    id: row.id as string,
    workspaceIdentity: row.workspace_identity as string,
    workspacePath: row.workspace_path as string,
    kind: row.kind as WorkspaceResourceIndexEntry["kind"],
    title: row.title as string,
    ...(row.filename ? { filename: row.filename as string } : {}),
    sourceOrigin: row.source_origin as WorkspaceResourceIndexEntry["sourceOrigin"],
    addedAt: row.added_at as number,
    updatedAt: row.updated_at as number,
    ...(row.last_referenced_at !== null && row.last_referenced_at !== undefined
      ? { lastReferencedAt: row.last_referenced_at as number }
      : {}),
    variants,
    references,
    ...(row.tags ? { tags: JSON.parse(row.tags as string) as string[] } : {}),
    ...(row.meta ? { meta: JSON.parse(row.meta as string) as WorkspaceResourceIndexEntry["meta"] } : {}),
  };
}

function rowToVariant(row: Record<string, unknown>): WorkspaceResourceVariant {
  return {
    kind: row.kind as WorkspaceResourceVariant["kind"],
    mime: row.mime as string,
    bytes: row.bytes as number,
    ...(row.sha256 ? { sha256: row.sha256 as string } : {}),
    ...(row.artifact_uri ? { artifactUri: row.artifact_uri as string } : {}),
    ...(row.path ? { path: row.path as string } : {}),
    ...(row.meta ? { meta: JSON.parse(row.meta as string) as Record<string, unknown> } : {}),
  };
}

function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function escapeJsonString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}