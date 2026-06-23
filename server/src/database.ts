import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryRow, Relation, MemoryType, RelationType } from './types.js';
import { embeddingToBuffer, bufferToEmbedding, MODEL_NAME, EMBEDDING_DIM } from './embeddings.js';
import { THRESHOLDS, TYPE_DECAY, RELATION_WEIGHT } from './thresholds.js';
import type { ScoringWeights } from './thresholds.js';

type Migration = { version: number; up: (db: Database.Database) => void };

export type HealthStats = {
  total: number;
  byType: Record<string, number>;
  withEmbedding: number;
  withoutEmbedding: number;
  staleCount: number;
  ageDistribution: { last24h: number; last7d: number; last30d: number; older: number };
  sessionCount: number;
  lastConsolidation: number;
  qualityMetrics: {
    accessedRatio: number;
    avgImportance: number;
    importanceDistribution: { low: number; medium: number; high: number };
    injectionStats: {
      totalInjections: number;
      neverInjected: number;
      avgInjectionCount: number;
      topInjected: number;
    };
  };
  relationStats: {
    relCount: number;
    linkDensity: number;
    isolated: number;
    avgRelWeight: number;
    strongRelShare: number;
    lastSweep: number;
  };
};

/** Adds a column if it is not already present (idempotent). */
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Ordered, idempotent schema migrations. A fresh database is built directly by
 * createSchema() at the latest version and skips all migrations; an existing
 * database runs every migration whose version is greater than its current
 * schema_version, each inside its own transaction. Every `up` MUST be safe to
 * re-run on a database that already has the change (use CREATE ... IF NOT EXISTS
 * and addColumnIfMissing) so partially-patched pre-migration installs upgrade
 * cleanly. Migrations start at v2; v1 is the base schema (createSchema).
 */
const MIGRATIONS: Migration[] = [
  {
    // v2: columns/tables previously patched in ad-hoc at startup for older installs.
    version: 2,
    up: (db) => {
      addColumnIfMissing(db, 'memories', 'injection_count', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(`
        CREATE TABLE IF NOT EXISTS relation_coactivations (
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (source_id, target_id),
          FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
          FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE,
          CHECK (source_id < target_id)
        );
        CREATE INDEX IF NOT EXISTS idx_coact_count ON relation_coactivations(count DESC);
      `);
    },
  },
  {
    // v3: add a `type` partition key to memories_vec so KNN can filter by type.
    // sqlite-vec applies the KNN LIMIT before any post-filter, so a type filter
    // applied after the fact can miss same-type rows (broken dedup + typed search).
    // vec0 tables can't be ALTERed or RENAMEd (shadow tables don't follow a rename),
    // so rebuild in place: read the source-of-truth blobs from memories.embedding,
    // drop the index, recreate it with the partition key, and repopulate.
    version: 3,
    up: (db) => {
      const rows = db
        .prepare('SELECT rowid, type, embedding FROM memories WHERE embedding IS NOT NULL')
        .all() as { rowid: number; type: string; embedding: Buffer }[];
      db.exec('DROP TABLE IF EXISTS memories_vec');
      db.exec(
        `CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[384] distance_metric=cosine, type text partition key)`,
      );
      const ins = db.prepare('INSERT INTO memories_vec (rowid, embedding, type) VALUES (?, ?, ?)');
      for (const r of rows) {
        ins.run(BigInt(r.rowid), bufferToEmbedding(r.embedding), r.type);
      }
    },
  },
  {
    // v4: supersession marker. Non-null = superseded (stale), excluded from search
    // and injection but kept in the DB. Set by version-bump supersession-on-write or
    // by the project-version staleness pass.
    version: 4,
    up: (db) => {
      addColumnIfMissing(db, 'memories', 'superseded_by', 'TEXT');
    },
  },
];

const SCHEMA_VERSION = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 1;

function sanitizeFtsQuery(query: string): string {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

// FTS5 BM25 produces near-zero scores when query terms appear in >50% of documents
// (negative IDF). An FTS match still indicates topic relevance, so we apply a floor
// to distinguish "FTS matched with common terms" from "FTS didn't match at all".
const FTS_MATCH_FLOOR = 0.05;

/** Two-phase recency decay: steep 0–7 day drop, then gradual exponential plateau. */
export function recencyScore(ageDays: number): number {
  if (ageDays <= 0) return 1.0;
  if (ageDays <= THRESHOLDS.RECENCY_SHORT_TERM_DAYS) {
    return 1 - THRESHOLDS.RECENCY_SHORT_TERM_DROP * (ageDays / THRESHOLDS.RECENCY_SHORT_TERM_DAYS);
  }
  return (
    (1 - THRESHOLDS.RECENCY_SHORT_TERM_DROP) *
    Math.exp(-(ageDays - THRESHOLDS.RECENCY_SHORT_TERM_DAYS) / THRESHOLDS.RECENCY_LONG_TERM_TAU)
  );
}

/** Penalty for overly long content that tends to match many queries generically. */
export function contentLengthPenalty(contentLength: number): number {
  if (contentLength <= THRESHOLDS.CONTENT_LENGTH_PENALTY_START) return 0;
  const excess = contentLength - THRESHOLDS.CONTENT_LENGTH_PENALTY_START;
  return THRESHOLDS.CONTENT_LENGTH_PENALTY_MAX * (1 - Math.exp(-excess / THRESHOLDS.CONTENT_LENGTH_PENALTY_SCALE));
}

export type RelevanceFilterOptions = {
  topicThreshold?: number;
  relevanceThreshold?: number;
  /**
   * Restrict the search to one memory type. Pushed into BOTH the FTS query and the
   * vec0 KNN (via the partition key) so the limit is applied within the type — a
   * post-hoc `.filter(r => r.type === t)` would starve typed searches when other
   * types dominate the candidate pool.
   */
  type?: MemoryType;
};

export interface ScoredMemoryRow extends MemoryRow {
  score: number;
  textScore: number;
}

export class MemoryDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    sqliteVec.load(this.db);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;

    if (!row) {
      this.createSchema();
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else {
      this.runMigrations(row.version);
    }

    this.ensureEmbeddingMeta();
  }

  /** Runs every migration newer than currentVersion, each inside its own transaction. */
  private runMigrations(currentVersion: number): void {
    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      const tx = this.db.transaction(() => {
        migration.up(this.db);
        this.db.prepare('UPDATE schema_version SET version = ?').run(migration.version);
      });
      tx();
    }
  }

  /**
   * Records the embedding model + dimension this database was built with, and
   * fails loudly if a later open uses a different model/dimension. The vec0 index
   * is a fixed `float[EMBEDDING_DIM]`, so silently writing vectors of a different
   * model or dimension would corrupt search; detection here turns that into a
   * clear, actionable error instead. First open (or a pre-meta install) seeds the
   * values rather than failing.
   */
  private ensureEmbeddingMeta(): void {
    const storedModel = this.getSessionMeta('embedding_model');
    const storedDim = this.getSessionMeta('embedding_dim');

    if (storedModel === null && storedDim === null) {
      this.setSessionMeta('embedding_model', MODEL_NAME);
      this.setSessionMeta('embedding_dim', String(EMBEDDING_DIM));
      return;
    }

    if (storedDim !== null && storedDim !== String(EMBEDDING_DIM)) {
      throw new Error(
        `Embedding dimension mismatch: database was built with dim=${storedDim} but the current ` +
          `model produces dim=${EMBEDDING_DIM}. The vec0 index cannot mix dimensions. Re-embed the ` +
          `database or point at a model with dim=${storedDim}.`,
      );
    }

    if (storedModel !== null && storedModel !== MODEL_NAME) {
      throw new Error(
        `Embedding model mismatch: database was built with "${storedModel}" but the current model is ` +
          `"${MODEL_NAME}". Mixing models degrades similarity search. Re-embed the database or restore ` +
          `the original model.`,
      );
    }

    // Backfill a missing half (e.g. dim recorded but model not) without failing.
    if (storedModel === null) this.setSessionMeta('embedding_model', MODEL_NAME);
    if (storedDim === null) this.setSessionMeta('embedding_dim', String(EMBEDDING_DIM));
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural', 'working', 'pattern')),
        title TEXT,
        content TEXT NOT NULL,
        context TEXT,
        source TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT,
        injection_count INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        embedding BLOB
      );

      CREATE TABLE IF NOT EXISTS relations (
        source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK(relation_type IN (
          'relates_to', 'depends_on', 'contradicts', 'extends', 'implements', 'derived_from'
        )),
        weight REAL NOT NULL DEFAULT 0.5,
        PRIMARY KEY (source_id, target_id, relation_type)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, content, tags, tokenize='porter unicode61'
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        embedding float[384] distance_metric=cosine,
        type text partition key
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relation_coactivations (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, target_id),
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE,
        CHECK (source_id < target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_coact_count ON relation_coactivations(count DESC);
    `);
  }

  // --- Memory CRUD ---

  insertMemory(memory: MemoryRow & { embedding?: Buffer | null }): void {
    const insert = this.db.prepare(`
      INSERT INTO memories (id, type, title, content, context, source, tags, importance, created_at, updated_at, access_count, last_accessed, embedding)
      VALUES (@id, @type, @title, @content, @context, @source, @tags, @importance, @created_at, @updated_at, @access_count, @last_accessed, @embedding)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO memories_fts (rowid, title, content, tags)
      VALUES ((SELECT rowid FROM memories WHERE id = @id), @title, @content, @tags)
    `);
    const insertVec = this.db.prepare('INSERT INTO memories_vec (rowid, embedding, type) VALUES (?, ?, ?)');
    const tx = this.db.transaction((m: MemoryRow & { embedding?: Buffer | null }) => {
      insert.run({ ...m, embedding: m.embedding ?? null });
      insertFts.run({ id: m.id, title: m.title ?? '', content: m.content, tags: m.tags });
      if (m.embedding) {
        const rowid = (this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(m.id) as { rowid: number }).rowid;
        insertVec.run(BigInt(rowid), bufferToEmbedding(m.embedding), m.type);
      }
    });
    tx(memory);
  }

  updateMemoryEmbedding(id: string, embedding: Float32Array): void {
    const buf = embeddingToBuffer(embedding);
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf, id);
      const row = this.db.prepare('SELECT rowid, type FROM memories WHERE id = ?').get(id) as
        | { rowid: number; type: MemoryType }
        | undefined;
      if (row !== undefined) {
        this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(row.rowid);
        this.db
          .prepare('INSERT INTO memories_vec (rowid, embedding, type) VALUES (?, ?, ?)')
          .run(BigInt(row.rowid), embedding, row.type);
      }
    });
    tx();
  }

  updateMemory(
    id: string,
    updates: Partial<Pick<MemoryRow, 'title' | 'content' | 'context' | 'source' | 'tags' | 'importance'>>,
  ): MemoryRow | null {
    const existing = this.getMemoryByIdRaw(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = @now'];
    const params: Record<string, unknown> = { id, now };

    if (updates.title !== undefined) {
      sets.push('title = @title');
      params.title = updates.title;
    }
    if (updates.content !== undefined) {
      sets.push('content = @content');
      params.content = updates.content;
    }
    if (updates.context !== undefined) {
      sets.push('context = @context');
      params.context = updates.context;
    }
    if (updates.source !== undefined) {
      sets.push('source = @source');
      params.source = updates.source;
    }
    if (updates.tags !== undefined) {
      sets.push('tags = @tags');
      params.tags = updates.tags;
    }
    if (updates.importance !== undefined) {
      sets.push('importance = @importance');
      params.importance = updates.importance;
    }

    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params);

      this.db.prepare('DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').run(id);
      const updated = this.getMemoryByIdRaw(id);
      if (!updated) throw new Error(`Memory ${id} not found after update`);
      this.db
        .prepare(
          `INSERT INTO memories_fts (rowid, title, content, tags)
           VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, ?, ?)`,
        )
        .run(id, updated.title ?? '', updated.content, updated.tags);
    });
    tx();
    return this.getMemoryByIdRaw(id);
  }

  getMemoryByIdRaw(id: string): MemoryRow | null {
    return (this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined) ?? null;
  }

  get path(): string {
    return this.db.name;
  }

  getMemoryById(id: string): MemoryRow | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return null;
    this.db
      .prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
    return row;
  }

  incrementInjectionCount(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE memories SET injection_count = injection_count + 1 WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  deleteMemory(id: string): boolean {
    const tx = this.db.transaction(() => {
      const rowid = (
        this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined
      )?.rowid;
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').run(id);
      if (rowid !== undefined) {
        this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(rowid);
      }
      const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return result.changes > 0;
    });
    return tx();
  }

  searchMemories(query: string, limit = 20): MemoryRow[] {
    const safeQuery = sanitizeFtsQuery(query);
    if (!safeQuery) return [];
    return this.db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON fts.rowid = m.rowid
         WHERE memories_fts MATCH @query
         ORDER BY rank
         LIMIT @limit`,
      )
      .all({ query: safeQuery, limit }) as MemoryRow[];
  }

  hybridSearchMemories(
    query: string,
    queryEmbedding: Float32Array | null,
    limit = 20,
    filter?: RelevanceFilterOptions,
    weights?: ScoringWeights,
  ): ScoredMemoryRow[] {
    const type = filter?.type;
    const ftsResults = new Map<string, { row: MemoryRow; ftsScore: number }>();
    const safeQuery = sanitizeFtsQuery(query);
    if (safeQuery) {
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT m.*, rank as fts_rank FROM memories m
             JOIN memories_fts fts ON fts.rowid = m.rowid
             WHERE memories_fts MATCH @query${type ? ' AND m.type = @type' : ''}
             ORDER BY rank
             LIMIT @limit`,
          )
          .all(
            type ? { query: safeQuery, limit: limit * 2, type } : { query: safeQuery, limit: limit * 2 },
          ) as (MemoryRow & { fts_rank: number })[];

        for (const row of ftsRows) {
          const rawScore = Math.min(1, Math.max(0, -row.fts_rank / 20));
          ftsResults.set(row.id, { row, ftsScore: Math.max(FTS_MATCH_FLOOR, rawScore) });
        }
      } catch {
        // FTS query syntax error - skip FTS
      }
    }

    const vectorResults = new Map<string, { row: MemoryRow; vecScore: number }>();
    if (queryEmbedding) {
      // With a type filter, push it into the KNN via the partition key (`AND k = ? AND type = ?`)
      // so the limit is applied within the type. Otherwise scan all partitions.
      const vecRows = (
        type
          ? this.db
              .prepare(
                `SELECT v.vec_rowid, v.distance, m.*
                 FROM (
                   SELECT rowid AS vec_rowid, distance
                   FROM memories_vec
                   WHERE embedding MATCH ? AND k = ? AND type = ?
                 ) v
                 JOIN memories m ON m.rowid = v.vec_rowid`,
              )
              .all(queryEmbedding, limit * 2, type)
          : this.db
              .prepare(
                `SELECT v.vec_rowid, v.distance, m.*
                 FROM (
                   SELECT rowid AS vec_rowid, distance
                   FROM memories_vec
                   WHERE embedding MATCH ?
                   ORDER BY distance
                   LIMIT ?
                 ) v
                 JOIN memories m ON m.rowid = v.vec_rowid`,
              )
              .all(queryEmbedding, limit * 2)
      ) as (MemoryRow & { distance: number; vec_rowid: number })[];

      for (const row of vecRows) {
        const similarity = 1 - row.distance;
        if (similarity > 0.2) {
          vectorResults.set(row.id, { row, vecScore: similarity });
        }
      }
    }

    const allIds = new Set([...ftsResults.keys(), ...vectorResults.keys()]);
    const scored: ScoredMemoryRow[] = [];
    const now = Date.now();
    const topicThreshold = filter?.topicThreshold ?? 0.05;
    const relevanceThreshold = filter?.relevanceThreshold ?? 0;
    const w = weights ?? THRESHOLDS.SCORING_WEIGHTS;

    for (const id of allIds) {
      const fts = ftsResults.get(id);
      const vec = vectorResults.get(id);
      const row = fts?.row ?? vec?.row;
      if (!row) continue;
      // Superseded (stale) memories never surface in search or injection.
      if (row.superseded_by != null) continue;

      const ftsScore = fts?.ftsScore ?? 0;
      const vecScore = vec?.vecScore ?? 0;

      // Probabilistic-OR (noisy-OR) fusion of the two signals. It is monotonic — a
      // dual-signal match always scores >= max(its single-signal scores), since
      // a + b - a*b - a = b*(1 - a) >= 0 (and symmetrically >= b) — so finding a
      // memory by both FTS and vector can never rank it below finding it by one.
      // (The old `fts*0.4 + vec*0.6` blend violated this: a floored FTS score of
      // 0.05 plus a strong vec score of 0.9 gave 0.56, below the 0.9 vec-only score.)
      // Single-signal cases collapse to the present operand (the other is 0), and the
      // result stays in [0,1] so the topic/relevance thresholds and strictness presets
      // keep their meaning.
      const textScore = ftsScore + vecScore - ftsScore * vecScore;

      if (textScore < topicThreshold) continue;

      const ageMs = now - new Date(row.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyBoost = recencyScore(ageDays);
      const importanceWeight = row.importance;
      const lengthPenalty = contentLengthPenalty(row.content.length);

      const finalScore = Math.max(
        0,
        textScore * w.textScore + importanceWeight * w.importance + recencyBoost * w.recency - lengthPenalty,
      );

      if (relevanceThreshold > 0 && finalScore < relevanceThreshold) continue;

      scored.push({ ...row, score: finalScore, textScore });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit);

    return results;
  }

  getMemoryIdsWithoutEmbedding(): string[] {
    return (this.db.prepare('SELECT id FROM memories WHERE embedding IS NULL').all() as { id: string }[]).map(
      (r) => r.id,
    );
  }

  listMemories(type?: MemoryType, limit = 20, offset = 0): MemoryRow[] {
    if (type) {
      return this.db
        .prepare(
          `SELECT * FROM memories WHERE type = @type
           ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
        )
        .all({ type, limit, offset }) as MemoryRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM memories
         ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ limit, offset }) as MemoryRow[];
  }

  findMemoryByTag(type: MemoryType, tag: string): MemoryRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM memories WHERE type = @type AND tags LIKE @pattern
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get({ type, pattern: `%"${tag}"%` }) as MemoryRow | undefined;
    return row ?? null;
  }

  countMemories(type?: MemoryType): number {
    if (type) {
      return (this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE type = ?').get(type) as { count: number })
        .count;
    }
    return (this.db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
  }

  // --- Relations ---

  addRelation(sourceId: string, targetId: string, relationType: RelationType, weight = 0.5): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO relations (source_id, target_id, relation_type, weight)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sourceId, targetId, relationType, weight);
  }

  getRelations(id: string): Relation[] {
    return this.db
      .prepare(
        `SELECT * FROM relations
         WHERE source_id = ? OR target_id = ?`,
      )
      .all(id, id) as Relation[];
  }

  getAllRelations(): Relation[] {
    return this.db.prepare('SELECT * FROM relations').all() as Relation[];
  }

  private normalisePair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  incrementCoActivation(a: string, b: string): number {
    if (a === b) return 0;
    const [source, target] = this.normalisePair(a, b);
    const stmt = this.db.prepare(`
      INSERT INTO relation_coactivations (source_id, target_id, count)
      VALUES (?, ?, 1)
      ON CONFLICT(source_id, target_id) DO UPDATE SET count = count + 1
      RETURNING count
    `);
    const row = stmt.get(source, target) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  getCoActivationCount(a: string, b: string): number {
    if (a === b) return 0;
    const [source, target] = this.normalisePair(a, b);
    const row = this.db
      .prepare('SELECT count FROM relation_coactivations WHERE source_id = ? AND target_id = ?')
      .get(source, target) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  resetCoActivation(a: string, b: string): void {
    if (a === b) return;
    const [source, target] = this.normalisePair(a, b);
    this.db
      .prepare('DELETE FROM relation_coactivations WHERE source_id = ? AND target_id = ?')
      .run(source, target);
  }

  getGraph(id: string, depth = 1, maxNodes = 50): { nodes: MemoryRow[]; relations: Relation[] } {
    const visited = new Set<string>();
    const allRelations: Relation[] = [];
    const queue: { nodeId: string; currentDepth: number }[] = [{ nodeId: id, currentDepth: 0 }];

    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) break;
      const { nodeId, currentDepth } = entry;
      if (visited.has(nodeId) || currentDepth > depth || visited.size >= maxNodes) continue;
      visited.add(nodeId);

      const relations = this.getRelations(nodeId);
      allRelations.push(...relations);

      if (currentDepth < depth) {
        for (const rel of relations) {
          const neighborId = rel.source_id === nodeId ? rel.target_id : rel.source_id;
          if (!visited.has(neighborId)) {
            queue.push({ nodeId: neighborId, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    const nodes = [...visited].map((nid) => this.getMemoryByIdRaw(nid)).filter((n): n is MemoryRow => n !== null);

    // Only keep relations whose both endpoints are inside the visited node set —
    // otherwise edges leak labels for nodes beyond `depth`.
    const uniqueRelations = allRelations.filter(
      (rel, idx, arr) =>
        visited.has(rel.source_id) &&
        visited.has(rel.target_id) &&
        arr.findIndex(
          (r) =>
            r.source_id === rel.source_id && r.target_id === rel.target_id && r.relation_type === rel.relation_type,
        ) === idx,
    );

    return { nodes, relations: uniqueRelations };
  }

  deleteRelation(sourceId: string, targetId: string, relationType: RelationType): boolean {
    const result = this.db
      .prepare('DELETE FROM relations WHERE source_id = ? AND target_id = ? AND relation_type = ?')
      .run(sourceId, targetId, relationType);
    return result.changes > 0;
  }

  // --- Cleanup ---

  deleteAllWorkingMemories(): number {
    const tx = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM memories_fts WHERE rowid IN (
          SELECT rowid FROM memories WHERE type = 'working'
        )
      `);
      this.db.exec(`
        DELETE FROM memories_vec WHERE rowid IN (
          SELECT rowid FROM memories WHERE type = 'working'
        )
      `);
      const result = this.db.prepare("DELETE FROM memories WHERE type = 'working'").run();
      return result.changes;
    });
    return tx();
  }

  cleanupWorkingMemories(maxAgeHours = 24): number {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          DELETE FROM memories_fts WHERE rowid IN (
            SELECT rowid FROM memories WHERE type = 'working' AND created_at < ?
          )
        `,
        )
        .run(cutoff);
      this.db
        .prepare(
          `
          DELETE FROM memories_vec WHERE rowid IN (
            SELECT rowid FROM memories WHERE type = 'working' AND created_at < ?
          )
        `,
        )
        .run(cutoff);
      const result = this.db.prepare("DELETE FROM memories WHERE type = 'working' AND created_at < ?").run(cutoff);
      return result.changes;
    });
    return tx();
  }

  cleanupOldEpisodicMemories(maxAgeDays = 60): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const tx = this.db.transaction(() => {
      const targets = this.db
        .prepare(
          `SELECT rowid, id FROM memories
           WHERE type = 'episodic'
             AND created_at < ?
             AND importance < 0.4
             AND access_count < 1`,
        )
        .all(cutoff) as { rowid: number; id: string }[];

      if (targets.length === 0) return 0;

      const ids = targets.map((t) => t.id);
      const rowids = targets.map((t) => t.rowid);

      for (const rowid of rowids) {
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid);
        this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(rowid);
      }
      const placeholders = ids.map(() => '?').join(',');
      const result = this.db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
      return result.changes;
    });
    return tx();
  }

  sweepRelations(opts: { batchSize?: number; neighborCandidates?: number; timeBudgetMs?: number } = {}): {
    processed: number;
    created: number;
  } {
    const batchSize = opts.batchSize ?? 100;
    const neighborCandidates = opts.neighborCandidates ?? 20;
    const timeBudgetMs = opts.timeBudgetMs ?? 500;
    const start = Date.now();

    const candidates = this.db
      .prepare(
        `SELECT m.id, m.type, m.tags, m.rowid AS r,
          (SELECT COUNT(*) FROM relations r WHERE r.source_id = m.id OR r.target_id = m.id) AS rel_count
        FROM memories m
        WHERE m.embedding IS NOT NULL
        ORDER BY rel_count ASC, m.created_at DESC
        LIMIT ?`,
      )
      .all(batchSize) as Array<{ id: string; type: string; tags: string; r: number; rel_count: number }>;

    let processed = 0;
    let created = 0;

    for (const c of candidates) {
      if (Date.now() - start > timeBudgetMs) break;
      processed++;

      const embRow = this.db
        .prepare('SELECT embedding FROM memories_vec WHERE rowid = ?')
        .get(c.r) as { embedding: Buffer } | undefined;
      if (!embRow?.embedding) continue;

      const neighbours = this.db
        .prepare(
          `SELECT v.vec_rowid, v.distance, m.id AS target_id, m.type AS target_type, m.tags AS target_tags
          FROM (
            SELECT rowid AS vec_rowid, distance
            FROM memories_vec
            WHERE embedding MATCH ?
            ORDER BY distance
            LIMIT ?
          ) v
          JOIN memories m ON m.rowid = v.vec_rowid`,
        )
        .all(embRow.embedding, neighborCandidates) as Array<{
        vec_rowid: number;
        distance: number;
        target_id: string;
        target_type: string;
        target_tags: string;
      }>;

      for (const n of neighbours) {
        if (Date.now() - start > timeBudgetMs) break;
        if (n.target_id === c.id) continue;

        const existing = this.db
          .prepare(
            `SELECT 1 FROM relations
            WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)
            LIMIT 1`,
          )
          .get(c.id, n.target_id, n.target_id, c.id);
        if (existing) continue;

        const similarity = 1 - n.distance;
        // Same-type near-duplicate not merged → contradicts (drift signal)
        if (c.type === n.target_type && n.distance < 0.15) {
          try {
            this.addRelation(c.id, n.target_id, 'contradicts', Math.max(0, 1 - n.distance));
            created++;
            continue;
          } catch {
            // dupe
          }
        }
        // Same-type moderate similarity → extends
        if (c.type === n.target_type && n.distance >= 0.15 && n.distance <= 0.35) {
          try {
            this.addRelation(c.id, n.target_id, 'extends', similarity);
            created++;
            continue;
          } catch {
            // dupe
          }
        }
        // Different types + ≥ 2 shared tags → relates_to
        if (c.type !== n.target_type) {
          let cTags: string[] = [];
          let nTags: string[] = [];
          try {
            cTags = JSON.parse(c.tags) as string[];
          } catch {
            cTags = [];
          }
          try {
            nTags = JSON.parse(n.target_tags) as string[];
          } catch {
            nTags = [];
          }
          const shared = cTags.filter((t) => nTags.includes(t)).length;
          if (shared >= 2) {
            try {
              this.addRelation(
                c.id,
                n.target_id,
                'relates_to',
                Math.min(0.8, 0.3 + 0.1 * shared),
              );
              created++;
            } catch {
              // dupe
            }
          }
        }
      }
    }

    this.setSessionMeta('last_sweep_session', this.getSessionMeta('session_count') ?? '0');
    return { processed, created };
  }

  decayRelationWeights(): number {
    const res = this.db
      .prepare(`UPDATE relations SET weight = MAX(?, weight - ?)`)
      .run(RELATION_WEIGHT.floor, RELATION_WEIGHT.decayPerSession);
    return res.changes;
  }

  boostRelationOnCoInject(a: string, b: string): void {
    this.db
      .prepare(
        `UPDATE relations
        SET weight = MIN(1.0, weight + ?)
        WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
      )
      .run(RELATION_WEIGHT.boostOnCoInject, a, b, b, a);
  }

  boostRelationOnCoAccess(a: string, b: string): void {
    this.db
      .prepare(
        `UPDATE relations
        SET weight = MIN(1.0, weight + ?)
        WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
      )
      .run(RELATION_WEIGHT.boostOnCoAccess, a, b, b, a);
  }

  pruneStaleRelations(): number {
    const res = this.db
      .prepare(
        `DELETE FROM relations
        WHERE weight < ?
          AND source_id IN (SELECT id FROM memories WHERE access_count = 0)
          AND target_id IN (SELECT id FROM memories WHERE access_count = 0)`,
      )
      .run(RELATION_WEIGHT.floor);
    return res.changes;
  }

  decayImportanceByType(): { decayed: number; deleted: number } {
    const stmt = this.db.prepare(
      `UPDATE memories SET importance = MAX(0, importance - ?) WHERE type = ? AND importance > 0`,
    );
    let decayed = 0;
    for (const [type, cfg] of Object.entries(TYPE_DECAY)) {
      const res = stmt.run(cfg.perSession, type);
      decayed += res.changes;
    }

    let deleted = 0;
    for (const [type, cfg] of Object.entries(TYPE_DECAY)) {
      if (!Number.isFinite(cfg.ageOutDays)) continue;
      const cutoff = new Date(Date.now() - cfg.ageOutDays * 24 * 60 * 60 * 1000).toISOString();
      const delStmt = this.db.prepare(`
        DELETE FROM memories
        WHERE type = ?
          AND created_at < ?
          AND importance < ?
          AND injection_count = 0
          AND access_count = 0
          AND id NOT IN (SELECT source_id FROM relations UNION SELECT target_id FROM relations)
      `);
      const r = delStmt.run(type, cutoff, cfg.staleImpThreshold);
      deleted += r.changes;
    }

    return { decayed, deleted };
  }

  decayImportance(daysThreshold: number, decayRate: number): number {
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000).toISOString();
    const stmtFull = this.db.prepare(
      `UPDATE memories
       SET importance = MAX(0.1, importance * (1 - ?))
       WHERE (last_accessed IS NULL OR last_accessed < ?)
         AND importance > 0.1
         AND type NOT IN ('working')
         AND access_count <= 5`,
    );
    const stmtHalf = this.db.prepare(
      `UPDATE memories
       SET importance = MAX(0.1, importance * (1 - ?))
       WHERE (last_accessed IS NULL OR last_accessed < ?)
         AND importance > 0.1
         AND type NOT IN ('working')
         AND access_count > 5 AND access_count <= 10`,
    );
    const stmtQuarter = this.db.prepare(
      `UPDATE memories
       SET importance = MAX(0.1, importance * (1 - ?))
       WHERE (last_accessed IS NULL OR last_accessed < ?)
         AND importance > 0.1
         AND type NOT IN ('working')
         AND access_count > 10`,
    );
    const r1 = stmtFull.run(decayRate, cutoff);
    const r2 = stmtHalf.run(decayRate * 0.5, cutoff);
    const r3 = stmtQuarter.run(decayRate * 0.25, cutoff);
    return r1.changes + r2.changes + r3.changes;
  }

  /** Reinforce a single memory's importance, clamped at 1.0. Counterpart to the decay passes. */
  boostImportance(id: string, delta: number): boolean {
    const res = this.db
      .prepare('UPDATE memories SET importance = MIN(1.0, importance + ?), updated_at = ? WHERE id = ?')
      .run(delta, new Date().toISOString(), id);
    return res.changes > 0;
  }

  findRelatedMemories(embedding: Float32Array, limit = 5): { id: string; distance: number }[] {
    const rows = this.db
      .prepare(
        `SELECT v.vec_rowid, v.distance, m.id
         FROM (
           SELECT rowid AS vec_rowid, distance
           FROM memories_vec
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?
         ) v
         JOIN memories m ON m.rowid = v.vec_rowid`,
      )
      .all(embedding, limit + 5) as { id: string; distance: number; vec_rowid: number }[];

    return rows
      .filter((r) => r.distance >= THRESHOLDS.EXACT_DUPLICATE && r.distance < THRESHOLDS.RELATED_UPPER)
      .slice(0, limit)
      .map(({ id, distance }) => ({ id, distance }));
  }

  findSimilarMemory(
    embedding: Float32Array,
    threshold: number = THRESHOLDS.EXACT_DUPLICATE,
    type?: MemoryType,
  ): { id: string; distance: number } | null {
    // With a type filter, push it into the KNN via the partition key so the nearest
    // SAME-TYPE row is returned even when many other-type rows are closer. The old
    // form took the global 5 nearest then filtered by type, missing same-type
    // duplicates ranked > 5 — store/consolidation dedup silently kept duplicates.
    const rows = (
      type
        ? this.db
            .prepare(
              `SELECT v.vec_rowid, v.distance, m.id
               FROM (
                 SELECT rowid AS vec_rowid, distance
                 FROM memories_vec
                 WHERE embedding MATCH ? AND k = ? AND type = ?
               ) v
               JOIN memories m ON m.rowid = v.vec_rowid`,
            )
            .all(embedding, 1, type)
        : this.db
            .prepare(
              `SELECT v.vec_rowid, v.distance, m.id
               FROM (
                 SELECT rowid AS vec_rowid, distance
                 FROM memories_vec
                 WHERE embedding MATCH ?
                 ORDER BY distance
                 LIMIT 1
               ) v
               JOIN memories m ON m.rowid = v.vec_rowid`,
            )
            .all(embedding)
    ) as {
      id: string;
      distance: number;
      vec_rowid: number;
    }[];

    if (rows.length > 0 && rows[0].distance < threshold) {
      return { id: rows[0].id, distance: rows[0].distance };
    }
    return null;
  }

  transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }

  // --- Convenience Queries ---

  getRecentEpisodicWithEmbeddings(maxAgeDays: number, limit: number): (MemoryRow & { embedding: Buffer })[] {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT * FROM memories
         WHERE type = 'episodic' AND embedding IS NOT NULL AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(cutoff, limit) as (MemoryRow & { embedding: Buffer })[];
  }

  getMemoriesByTypeWithEmbeddings(type: MemoryType, limit: number): (MemoryRow & { embedding: Buffer })[] {
    return this.db
      .prepare(
        `SELECT * FROM memories
         WHERE type = ? AND embedding IS NOT NULL
         ORDER BY importance DESC, created_at DESC LIMIT ?`,
      )
      .all(type, limit) as (MemoryRow & { embedding: Buffer })[];
  }

  mergeMemories(keepId: string, deleteId: string): boolean {
    const keep = this.getMemoryByIdRaw(keepId);
    const del = this.getMemoryByIdRaw(deleteId);
    if (!keep || !del) return false;

    const keepTags: string[] = JSON.parse(keep.tags);
    const delTags: string[] = JSON.parse(del.tags);
    const mergedTags = [...new Set([...keepTags, ...delTags])];

    const mergedContent = keep.content.length >= del.content.length ? keep.content : del.content;
    const mergedImportance = Math.min(0.95, Math.max(keep.importance, del.importance) + 0.05);

    const tx = this.db.transaction(() => {
      const rels = this.getRelations(deleteId);
      for (const rel of rels) {
        const newSource = rel.source_id === deleteId ? keepId : rel.source_id;
        const newTarget = rel.target_id === deleteId ? keepId : rel.target_id;
        if (newSource !== newTarget) {
          try {
            this.addRelation(newSource, newTarget, rel.relation_type, rel.weight);
          } catch {
            // Relation already exists
          }
        }
      }

      this.updateMemory(keepId, {
        content: mergedContent,
        tags: JSON.stringify(mergedTags),
        importance: mergedImportance,
      });

      this.deleteMemory(deleteId);
    });
    tx();
    return true;
  }

  findNearDuplicatePairs(
    type: MemoryType,
    threshold: number,
    limit: number,
  ): { id1: string; id2: string; distance: number }[] {
    const rows = this.db
      .prepare(
        `SELECT id, embedding FROM memories
         WHERE type = ? AND embedding IS NOT NULL
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all(type) as { id: string; embedding: Buffer }[];

    const pairs: { id1: string; id2: string; distance: number }[] = [];
    const seenPairs = new Set<string>();

    for (const row of rows) {
      const emb = bufferToEmbedding(row.embedding);
      // Push the type into the KNN via the partition key (k covers self + neighbours
      // within the type), so same-type near-duplicates ranked > 5 globally are still
      // found — the old `LIMIT 5` then `WHERE m.type` form missed them.
      const neighbors = this.db
        .prepare(
          `SELECT v.distance, m.id
           FROM (
             SELECT rowid AS vec_rowid, distance
             FROM memories_vec
             WHERE embedding MATCH ? AND k = ? AND type = ?
           ) v
           JOIN memories m ON m.rowid = v.vec_rowid`,
        )
        .all(emb, 6, type) as { id: string; distance: number }[];

      for (const n of neighbors) {
        if (n.id === row.id) continue;
        if (n.distance >= threshold) continue;
        const pairKey = [row.id, n.id].sort().join(':');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        pairs.push({ id1: row.id, id2: n.id, distance: n.distance });
      }

      if (pairs.length >= limit) break;
    }

    return pairs.slice(0, limit);
  }

  deleteStaleMemories(maxAgeDays: number, maxImportance: number, maxAccessCount: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const tx = this.db.transaction(() => {
      const targets = this.db
        .prepare(
          `SELECT rowid, id FROM memories
           WHERE created_at < ?
             AND importance < ?
             AND access_count <= ?
             AND type NOT IN ('pattern', 'procedural')`,
        )
        .all(cutoff, maxImportance, maxAccessCount) as { rowid: number; id: string }[];

      if (targets.length === 0) return 0;

      for (const t of targets) {
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(t.rowid);
        this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(t.rowid);
      }
      const placeholders = targets.map(() => '?').join(',');
      const ids = targets.map((t) => t.id);
      const result = this.db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
      return result.changes;
    });
    return tx();
  }

  getRecentByType(type: string, limit: number): MemoryRow[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE type = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ?')
      .all(type, limit) as MemoryRow[];
  }

  getTopByImportance(type: string, minImportance: number, limit: number): MemoryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE type = ? AND importance >= ? AND superseded_by IS NULL
         ORDER BY importance DESC, access_count DESC LIMIT ?`,
      )
      .all(type, minImportance, limit) as MemoryRow[];
  }

  /**
   * Marks `id` as superseded by `by` — either the id of a newer memory, or a
   * `project:<version>` sentinel from the staleness pass. Superseded memories are
   * excluded from search/injection but retained (visible via memory_list).
   */
  markSuperseded(id: string, by: string): void {
    this.db.prepare('UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?').run(by, new Date().toISOString(), id);
  }

  /** Semantic + pattern memories that are not yet superseded — input to the staleness pass. */
  getActiveByTypeForStaleness(): { id: string; type: string; title: string | null; content: string }[] {
    return this.db
      .prepare(
        `SELECT id, type, title, content FROM memories
         WHERE type IN ('semantic', 'pattern') AND superseded_by IS NULL`,
      )
      .all() as { id: string; type: string; title: string | null; content: string }[];
  }

  // --- Health & Curation ---

  getHealthStats(): HealthStats {
    const total = this.countMemories();

    const typeRows = this.db.prepare('SELECT type, COUNT(*) as count FROM memories GROUP BY type').all() as {
      type: string;
      count: number;
    }[];
    const byType: Record<string, number> = {};
    for (const row of typeRows) byType[row.type] = row.count;

    const withEmbedding = (
      this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL').get() as { count: number }
    ).count;
    const withoutEmbedding = total - withEmbedding;

    const staleCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM memories
           WHERE importance < 0.2 AND access_count < 2
             AND created_at < ? AND type != 'working'`,
        )
        .get(staleCutoff) as { count: number }
    ).count;

    const now = Date.now();
    const d24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const d7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const d30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    const last24h = (
      this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE created_at >= ?').get(d24h) as { count: number }
    ).count;
    const last7d = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM memories WHERE created_at >= ? AND created_at < ?')
        .get(d7d, d24h) as { count: number }
    ).count;
    const last30d = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM memories WHERE created_at >= ? AND created_at < ?')
        .get(d30d, d7d) as { count: number }
    ).count;
    const older = total - last24h - last7d - last30d;

    const sessionCount = parseInt(this.getSessionMeta('session_count') ?? '0', 10);
    const lastConsolidation = parseInt(this.getSessionMeta('last_consolidation') ?? '0', 10);

    // Quality metrics
    const accessedCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE access_count > 0').get() as { count: number }
    ).count;
    const accessedRatio = total > 0 ? accessedCount / total : 0;

    const avgImportance = (
      this.db.prepare('SELECT COALESCE(AVG(importance), 0) as avg FROM memories').get() as { avg: number }
    ).avg;

    const importanceDist = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN importance < 0.3 THEN 1 ELSE 0 END) as low,
          SUM(CASE WHEN importance >= 0.3 AND importance < 0.7 THEN 1 ELSE 0 END) as medium,
          SUM(CASE WHEN importance >= 0.7 THEN 1 ELSE 0 END) as high
        FROM memories`,
      )
      .get() as { low: number; medium: number; high: number };

    const injectionAgg = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(injection_count), 0) as totalInjections,
          COALESCE(AVG(injection_count), 0) as avgInjectionCount,
          COALESCE(MAX(injection_count), 0) as topInjected
        FROM memories`,
      )
      .get() as { totalInjections: number; avgInjectionCount: number; topInjected: number };

    const neverInjected = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM memories
           WHERE injection_count = 0 AND created_at < ? AND type != 'working'`,
        )
        .get(d7d) as { count: number }
    ).count;

    // Relation graph metrics
    const relCount = (this.db.prepare('SELECT COUNT(*) as c FROM relations').get() as { c: number }).c;
    const linkDensity = total > 0 ? (relCount * 2) / total : 0;
    const isolated = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM memories m
           WHERE NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_id = m.id OR r.target_id = m.id)`,
        )
        .get() as { c: number }
    ).c;
    const avgRelWeight =
      (this.db.prepare('SELECT COALESCE(AVG(weight), 0) as w FROM relations').get() as { w: number }).w ?? 0;
    const strongRelCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM relations WHERE weight >= 0.5').get() as { c: number }
    ).c;
    const strongRelShare = relCount > 0 ? strongRelCount / relCount : 0;
    const lastSweep = parseInt(this.getSessionMeta('last_sweep_session') ?? '0', 10);

    return {
      total,
      byType,
      withEmbedding,
      withoutEmbedding,
      staleCount,
      ageDistribution: { last24h, last7d, last30d, older },
      sessionCount,
      lastConsolidation,
      qualityMetrics: {
        accessedRatio,
        avgImportance,
        importanceDistribution: importanceDist,
        injectionStats: {
          totalInjections: injectionAgg.totalInjections,
          neverInjected,
          avgInjectionCount: injectionAgg.avgInjectionCount,
          topInjected: injectionAgg.topInjected,
        },
      },
      relationStats: {
        relCount,
        linkDensity,
        isolated,
        avgRelWeight,
        strongRelShare,
        lastSweep,
      },
    };
  }

  getCurationStats(): {
    total: number;
    byType: Record<string, number>;
    staleCount: number;
    duplicateCandidateCount: number;
  } {
    const total = this.countMemories();

    const typeRows = this.db.prepare('SELECT type, COUNT(*) as count FROM memories GROUP BY type').all() as {
      type: string;
      count: number;
    }[];
    const byType: Record<string, number> = {};
    for (const row of typeRows) byType[row.type] = row.count;

    const staleCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM memories
           WHERE importance < 0.2 AND access_count < 2
             AND created_at < ? AND type != 'working'`,
        )
        .get(staleCutoff) as { count: number }
    ).count;

    // Sample recent memories with embeddings to find near-duplicates
    let duplicateCandidateCount = 0;
    const sampleRows = this.db
      .prepare(
        `SELECT id, embedding FROM memories
         WHERE embedding IS NOT NULL
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all() as { id: string; embedding: Buffer }[];

    const seenPairs = new Set<string>();
    for (const row of sampleRows) {
      const emb = bufferToEmbedding(row.embedding);
      const neighbors = this.db
        .prepare(
          `SELECT v.distance, m.id
           FROM (
             SELECT rowid AS vec_rowid, distance
             FROM memories_vec
             WHERE embedding MATCH ?
             ORDER BY distance
             LIMIT 3
           ) v
           JOIN memories m ON m.rowid = v.vec_rowid`,
        )
        .all(emb) as { id: string; distance: number }[];

      for (const n of neighbors) {
        if (n.id === row.id) continue;
        if (n.distance >= THRESHOLDS.EXACT_DUPLICATE && n.distance < THRESHOLDS.NEAR_DUPLICATE) {
          const pairKey = [row.id, n.id].sort().join(':');
          if (!seenPairs.has(pairKey)) {
            seenPairs.add(pairKey);
            duplicateCandidateCount++;
          }
        }
      }
    }

    return { total, byType, staleCount, duplicateCandidateCount };
  }

  // --- Meta ---

  getSessionMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSessionMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  close(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
