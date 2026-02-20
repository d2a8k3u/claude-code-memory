/**
 * Shared database utilities for hooks.
 * ESM module — no build step required.
 */

import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, "..", "..", "..");

/**
 * Open the hook database at dbPath. Returns null on failure.
 * Validates that schema_version = 1 (unified schema).
 */
export function openHookDb(dbPath) {
  if (!existsSync(dbPath)) return null;

  let Database;
  try {
    const require = createRequire(join(pluginRoot, "server", "node_modules", "dummy.js"));
    Database = require("better-sqlite3");
  } catch {
    try {
      const require2 = createRequire(import.meta.url);
      Database = require2("better-sqlite3");
    } catch {
      return null;
    }
  }

  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");

    // Validate schema
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
    if (!row || row.version < 1) {
      db.close();
      return null;
    }

    return db;
  } catch {
    return null;
  }
}

/**
 * Sanitize a user query for FTS5 MATCH.
 */
export function sanitizeFtsQuery(query) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return "";
  return terms
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

/**
 * FTS5 search on memories_fts. Returns matching rows ordered by rank + importance + recency.
 */
export function searchMemoriesFts(db, query, { limit = 10, type = null } = {}) {
  const safeQuery = sanitizeFtsQuery(query);
  if (!safeQuery) return [];

  try {
    const typeClause = type ? "AND m.type = ?" : "";
    const params = type
      ? [safeQuery, type, limit]
      : [safeQuery, limit];

    return db.prepare(
      `SELECT m.*, rank AS fts_rank FROM memories m
       JOIN memories_fts fts ON fts.rowid = m.rowid
       WHERE memories_fts MATCH ?
       ${typeClause}
       ORDER BY rank * 0.5 + m.importance * -10 + (julianday('now') - julianday(m.created_at)) * 0.01
       LIMIT ?`
    ).all(...params);
  } catch {
    return [];
  }
}

/**
 * Insert an episodic memory with a proper ULID. No embedding (server backfills).
 */
export function insertEpisodicMemory(db, { content, context = null, tags = [], importance = 0.5 }) {
  const { ulid } = loadUlid();
  const id = ulid();
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(tags);

  db.prepare(`
    INSERT INTO memories (id, type, title, content, context, source, tags, importance, created_at, updated_at, access_count, last_accessed, embedding)
    VALUES (?, 'episodic', NULL, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL)
  `).run(id, content, context, tagsJson, importance, now, now);

  try {
    db.prepare(`
      INSERT INTO memories_fts (rowid, title, content, tags)
      VALUES ((SELECT rowid FROM memories WHERE id = ?), '', ?, ?)
    `).run(id, content, tagsJson);
  } catch { /* FTS insert failed — not critical */ }

  return id;
}

/**
 * Delete all working memories.
 */
export function deleteWorkingMemories(db) {
  try {
    db.exec(`
      DELETE FROM memories_fts WHERE rowid IN (
        SELECT rowid FROM memories WHERE type = 'working'
      )
    `);
  } catch { /* ignore */ }

  try {
    db.exec(`
      DELETE FROM memories_vec WHERE rowid IN (
        SELECT rowid FROM memories WHERE type = 'working'
      )
    `);
  } catch { /* vec0 may not exist */ }

  try {
    const result = db.prepare("DELETE FROM memories WHERE type = 'working'").run();
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Delete old low-value episodic memories.
 */
export function cleanupOldEpisodic(db, maxAgeDays = 90) {
  try {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const targets = db.prepare(
      `SELECT rowid, id FROM memories
       WHERE type = 'episodic'
         AND created_at < ?
         AND importance < 0.7
         AND access_count < 3`
    ).all(cutoff);

    if (targets.length === 0) return 0;

    for (const t of targets) {
      try { db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(t.rowid); } catch {}
      try { db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(t.rowid); } catch {}
    }

    const ids = targets.map(t => t.id);
    const placeholders = ids.map(() => "?").join(",");
    const result = db.prepare(
      `DELETE FROM memories WHERE id IN (${placeholders})`
    ).run(...ids);
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Decay importance for memories not accessed in daysThreshold days.
 */
export function decayImportance(db, daysThreshold = 30, decayAmount = 0.05) {
  try {
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare(
      `UPDATE memories
       SET importance = MAX(0.1, importance - ?)
       WHERE (last_accessed IS NULL OR last_accessed < ?)
         AND importance > 0.1
         AND type NOT IN ('working')`
    ).run(decayAmount, cutoff);
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Get recent episodic memories.
 */
export function getRecentEpisodic(db, limit = 3) {
  try {
    return db.prepare(
      `SELECT id, content, context, created_at, importance FROM memories
       WHERE type = 'episodic'
       ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
  } catch {
    return [];
  }
}

/**
 * Get top memories by importance, optionally filtered by type.
 */
export function getTopByImportance(db, { type = null, minImportance = 0.5, limit = 5 } = {}) {
  try {
    if (type) {
      return db.prepare(
        `SELECT id, title, content, tags, importance FROM memories
         WHERE type = ? AND importance >= ?
         ORDER BY importance DESC, access_count DESC LIMIT ?`
      ).all(type, minImportance, limit);
    }
    return db.prepare(
      `SELECT id, type, title, content, tags, importance FROM memories
       WHERE importance >= ?
       ORDER BY importance DESC, access_count DESC LIMIT ?`
    ).all(minImportance, limit);
  } catch {
    return [];
  }
}

/**
 * Get top pattern memories by importance.
 */
export function getPatterns(db, limit = 5) {
  try {
    return db.prepare(
      `SELECT id, title, content, importance FROM memories
       WHERE type = 'pattern'
       ORDER BY importance DESC, access_count DESC LIMIT ?`
    ).all(limit);
  } catch {
    return [];
  }
}

/**
 * Ensure meta table exists (should already from schema, but be safe).
 */
export function ensureMetaTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  } catch { /* ignore */ }
}

/**
 * Get a meta value.
 */
export function getSessionMeta(db, key) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Set a meta value.
 */
export function setSessionMeta(db, key, value) {
  try {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(value));
  } catch { /* ignore */ }
}

function loadUlid() {
  try {
    const require = createRequire(join(pluginRoot, "server", "node_modules", "dummy.js"));
    return require("ulid");
  } catch {
    // Fallback: generate a ULID-like ID
    return {
      ulid() {
        const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
        const rnd = Array.from({ length: 16 }, () =>
          "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)]
        ).join("");
        return ts + rnd;
      }
    };
  }
}
