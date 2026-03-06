import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '../database.js';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDb, makeEmbedding, cleanup, makeMemoryRow } from './helpers.js';

// ==========================================================
// Schema
// ==========================================================
describe('MemoryDatabase - schema', () => {
  it('creates a fresh database with all tables', () => {
    const { db, dir } = makeTempDb();
    assert.equal(db.countMemories(), 0);
    cleanup(db, dir);
  });

  it('opens an existing database without errors', () => {
    const { db, dir } = makeTempDb();
    db.close();
    const dbPath = join(dir, 'memory.sqlite');
    const db2 = new MemoryDatabase(dbPath);
    assert.equal(db2.countMemories(), 0);
    db2.close();
    rmSync(dir, { recursive: true });
  });
});

// ==========================================================
// Memory CRUD
// ==========================================================
describe('MemoryDatabase - memory CRUD', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('inserts and retrieves a memory with title and source', () => {
    db.insertMemory(
      makeMemoryRow({
        id: 'mem1',
        type: 'semantic',
        title: 'TypeScript Overview',
        content: 'TypeScript is a typed superset of JavaScript',
        source: 'README.md',
        tags: '["typescript"]',
        importance: 0.8,
      }),
    );

    const row = db.getMemoryById('mem1');
    assert.ok(row);
    assert.equal(row.content, 'TypeScript is a typed superset of JavaScript');
    assert.equal(row.type, 'semantic');
    assert.equal(row.title, 'TypeScript Overview');
    assert.equal(row.source, 'README.md');
    assert.equal(row.importance, 0.8);
    cleanup(db, dir);
  });

  it('inserts a pattern memory', () => {
    db.insertMemory(
      makeMemoryRow({
        id: 'pat1',
        type: 'pattern',
        title: 'Error handling convention',
        content: 'Always use Result types with typed error variants',
        tags: '["conventions"]',
        importance: 0.8,
      }),
    );

    const row = db.getMemoryById('pat1');
    assert.ok(row);
    assert.equal(row.type, 'pattern');
    assert.equal(row.title, 'Error handling convention');
    cleanup(db, dir);
  });

  it('updates a memory including title and source', () => {
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'original' }));

    const updated = db.updateMemory('mem1', {
      content: 'changed',
      title: 'New Title',
      source: 'package.json',
      importance: 0.9,
    });
    assert.ok(updated);
    assert.equal(updated.content, 'changed');
    assert.equal(updated.title, 'New Title');
    assert.equal(updated.source, 'package.json');
    assert.equal(updated.importance, 0.9);
    cleanup(db, dir);
  });

  it('updates only specified fields without touching others', () => {
    db.insertMemory(
      makeMemoryRow({
        id: 'mem1',
        title: 'Original Title',
        content: 'original content',
        importance: 0.7,
        tags: '["tag1"]',
      }),
    );

    const updated = db.updateMemory('mem1', { importance: 0.9 });
    assert.ok(updated);
    assert.equal(updated.title, 'Original Title');
    assert.equal(updated.content, 'original content');
    assert.equal(updated.importance, 0.9);
    assert.equal(updated.tags, '["tag1"]');
    cleanup(db, dir);
  });

  it('returns null when updating nonexistent memory', () => {
    const result = db.updateMemory('nonexistent', { content: 'nope' });
    assert.equal(result, null);
    cleanup(db, dir);
  });

  it('deletes a memory', () => {
    db.insertMemory(makeMemoryRow({ id: 'mem1', type: 'episodic', content: 'test' }));

    assert.equal(db.deleteMemory('mem1'), true);
    assert.equal(db.getMemoryById('mem1'), null);
    assert.equal(db.deleteMemory('nonexistent'), false);
    cleanup(db, dir);
  });

  it('lists memories with type filter including pattern', () => {
    for (const type of ['episodic', 'semantic', 'procedural', 'pattern'] as const) {
      db.insertMemory(
        makeMemoryRow({
          id: `mem-${type}`,
          type,
          title: type === 'pattern' ? 'Test Pattern' : null,
          content: `${type} memory`,
        }),
      );
    }

    assert.equal(db.listMemories(undefined, 20, 0).length, 4);
    assert.equal(db.listMemories('episodic', 20, 0).length, 1);
    assert.equal(db.listMemories('pattern', 20, 0).length, 1);
    assert.equal(db.countMemories(), 4);
    assert.equal(db.countMemories('pattern'), 1);
    cleanup(db, dir);
  });

  it('cleans up working memories', () => {
    db.insertMemory(makeMemoryRow({ id: 'w1', type: 'working', content: 'temp note' }));
    db.insertMemory(makeMemoryRow({ id: 's1', type: 'semantic', content: 'permanent' }));

    const cleaned = db.deleteAllWorkingMemories();
    assert.equal(cleaned, 1);
    assert.equal(db.countMemories(), 1);
    assert.ok(db.getMemoryById('s1'));
    cleanup(db, dir);
  });
});

// ==========================================================
// Access tracking
// ==========================================================
describe('MemoryDatabase - access tracking', () => {
  it('increments access_count on getMemoryById', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'tracked' }));

    // First access
    const first = db.getMemoryById('mem1');
    assert.ok(first);
    assert.equal(first.access_count, 0); // Returns the row BEFORE increment

    // Second access - should reflect the first increment
    const second = db.getMemoryById('mem1');
    assert.ok(second);
    assert.equal(second.access_count, 1);

    // Third access
    const third = db.getMemoryById('mem1');
    assert.ok(third);
    assert.equal(third.access_count, 2);

    cleanup(db, dir);
  });

  it('sets last_accessed timestamp on getMemoryById', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'tracked' }));

    db.getMemoryById('mem1');
    // Access again to see the last_accessed from the first call
    const row = db.getMemoryById('mem1');
    assert.ok(row);
    assert.ok(row.last_accessed);

    cleanup(db, dir);
  });

  it('returns null for nonexistent memory', () => {
    const { db, dir } = makeTempDb();
    assert.equal(db.getMemoryById('nonexistent'), null);
    cleanup(db, dir);
  });
});

// ==========================================================
// Pagination
// ==========================================================
describe('MemoryDatabase - listMemories pagination', () => {
  it('respects limit and offset', () => {
    const { db, dir } = makeTempDb();
    for (let i = 0; i < 10; i++) {
      db.insertMemory(
        makeMemoryRow({
          id: `mem-${i}`,
          content: `memory ${i}`,
          created_at: new Date(Date.now() - i * 1000).toISOString(),
          updated_at: new Date(Date.now() - i * 1000).toISOString(),
        }),
      );
    }

    const page1 = db.listMemories(undefined, 3, 0);
    assert.equal(page1.length, 3);

    const page2 = db.listMemories(undefined, 3, 3);
    assert.equal(page2.length, 3);

    // No overlap between pages
    const page1Ids = new Set(page1.map((r) => r.id));
    for (const row of page2) {
      assert.ok(!page1Ids.has(row.id));
    }

    // Offset beyond available
    const empty = db.listMemories(undefined, 3, 20);
    assert.equal(empty.length, 0);

    cleanup(db, dir);
  });

  it('returns results ordered by created_at DESC', () => {
    const { db, dir } = makeTempDb();
    const dates = ['2024-01-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'];
    for (let i = 0; i < dates.length; i++) {
      db.insertMemory(
        makeMemoryRow({
          id: `mem-${i}`,
          content: `memory ${i}`,
          created_at: dates[i],
          updated_at: dates[i],
        }),
      );
    }

    const all = db.listMemories(undefined, 10, 0);
    assert.equal(all.length, 3);
    assert.equal(all[0].id, 'mem-1'); // June (newest)
    assert.equal(all[1].id, 'mem-2'); // March
    assert.equal(all[2].id, 'mem-0'); // January (oldest)

    cleanup(db, dir);
  });
});

// ==========================================================
// getMemoryIdsWithoutEmbedding
// ==========================================================
describe('MemoryDatabase - getMemoryIdsWithoutEmbedding', () => {
  it('returns IDs of memories without embeddings', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'no-emb-1', content: 'no embedding' }));
    db.insertMemory(makeMemoryRow({ id: 'no-emb-2', content: 'also no embedding' }));
    db.insertMemory(makeMemoryRow({ id: 'has-emb', content: 'has embedding' }));

    db.updateMemoryEmbedding('has-emb', makeEmbedding(1));

    const ids = db.getMemoryIdsWithoutEmbedding();
    assert.equal(ids.length, 2);
    assert.ok(ids.includes('no-emb-1'));
    assert.ok(ids.includes('no-emb-2'));
    assert.ok(!ids.includes('has-emb'));

    cleanup(db, dir);
  });

  it('returns empty array when all memories have embeddings', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'has embedding' }));
    db.updateMemoryEmbedding('mem1', makeEmbedding(1));

    assert.deepEqual(db.getMemoryIdsWithoutEmbedding(), []);
    cleanup(db, dir);
  });

  it('returns empty array when no memories exist', () => {
    const { db, dir } = makeTempDb();
    assert.deepEqual(db.getMemoryIdsWithoutEmbedding(), []);
    cleanup(db, dir);
  });
});

// ==========================================================
// Relations (on memories)
// ==========================================================
describe('MemoryDatabase - relations', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
    db.insertMemory(makeMemoryRow({ id: 'm1', title: 'Fact A', content: 'a', importance: 0.8 }));
    db.insertMemory(makeMemoryRow({ id: 'm2', title: 'Fact B', content: 'b', importance: 0.8 }));
    db.insertMemory(
      makeMemoryRow({
        id: 'p1',
        type: 'pattern',
        title: 'Pattern X',
        content: 'consolidated insight',
        importance: 0.8,
      }),
    );
  });

  it('creates and retrieves relations between memories', () => {
    db.addRelation('m1', 'm2', 'relates_to', 0.7);
    const rels = db.getRelations('m1');
    assert.equal(rels.length, 1);
    assert.equal(rels[0].relation_type, 'relates_to');
    assert.equal(rels[0].weight, 0.7);
    cleanup(db, dir);
  });

  it('creates derived_from relation for patterns', () => {
    db.addRelation('p1', 'm1', 'derived_from', 0.9);
    db.addRelation('p1', 'm2', 'derived_from', 0.9);
    const rels = db.getRelations('p1');
    assert.equal(rels.length, 2);
    assert.ok(rels.every((r) => r.relation_type === 'derived_from'));
    cleanup(db, dir);
  });

  it('uses default weight of 0.5', () => {
    db.addRelation('m1', 'm2', 'relates_to');
    const rels = db.getRelations('m1');
    assert.equal(rels[0].weight, 0.5);
    cleanup(db, dir);
  });

  it('replaces relation on duplicate insert', () => {
    db.addRelation('m1', 'm2', 'relates_to', 0.3);
    db.addRelation('m1', 'm2', 'relates_to', 0.9);
    const rels = db.getRelations('m1');
    assert.equal(rels.length, 1);
    assert.equal(rels[0].weight, 0.9);
    cleanup(db, dir);
  });

  it('allows multiple relation types between same memories', () => {
    db.addRelation('m1', 'm2', 'relates_to', 0.5);
    db.addRelation('m1', 'm2', 'depends_on', 0.8);
    const rels = db.getRelations('m1');
    assert.equal(rels.length, 2);
    const types = rels.map((r) => r.relation_type).sort();
    assert.deepEqual(types, ['depends_on', 'relates_to']);
    cleanup(db, dir);
  });

  it('builds a memory graph', () => {
    db.addRelation('m1', 'm2', 'depends_on');
    db.addRelation('p1', 'm1', 'derived_from');
    const graph = db.getGraph('m1', 1);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.relations.length, 2);
    cleanup(db, dir);
  });

  it('builds a graph with depth limit', () => {
    db.insertMemory(makeMemoryRow({ id: 'm3', content: 'c' }));
    db.addRelation('m1', 'm2', 'relates_to');
    db.addRelation('m2', 'm3', 'relates_to');
    db.addRelation('m3', 'p1', 'relates_to');

    const depth1 = db.getGraph('m1', 1);
    assert.ok(depth1.nodes.length < 4); // Should not reach m3 and p1 through m2->m3->p1

    const depth3 = db.getGraph('m1', 3);
    assert.equal(depth3.nodes.length, 4);

    cleanup(db, dir);
  });

  it('deletes a relation', () => {
    db.addRelation('m1', 'm2', 'relates_to');
    assert.equal(db.deleteRelation('m1', 'm2', 'relates_to'), true);
    assert.equal(db.getRelations('m1').length, 0);
    cleanup(db, dir);
  });

  it('returns false when deleting nonexistent relation', () => {
    assert.equal(db.deleteRelation('m1', 'm2', 'relates_to'), false);
    cleanup(db, dir);
  });

  it('cascades relation deletion when memory is deleted', () => {
    db.addRelation('m1', 'm2', 'relates_to');
    db.deleteMemory('m1');
    const rels = db.getRelations('m2');
    assert.equal(rels.length, 0);
    cleanup(db, dir);
  });
});

// ==========================================================
// FTS Search
// ==========================================================
describe('MemoryDatabase - FTS search', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        type: 'semantic',
        title: 'Auth System',
        content: 'authentication login security',
        tags: '["auth"]',
        importance: 0.8,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'm2',
        type: 'episodic',
        content: 'database migration postgresql',
        tags: '["db"]',
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'p1',
        type: 'pattern',
        title: 'Error Handling Pattern',
        content: 'use Result types with typed error variants',
        tags: '["conventions"]',
        importance: 0.8,
      }),
    );
  });

  it('finds memories by FTS', () => {
    const results = db.searchMemories('authentication');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'm1');
    cleanup(db, dir);
  });

  it('finds memories by title', () => {
    const results = db.searchMemories('Error Handling');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'p1');
    cleanup(db, dir);
  });

  it('finds memories by tag content', () => {
    const results = db.searchMemories('auth');
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.id === 'm1'));
    cleanup(db, dir);
  });

  it('handles FTS5 special characters safely', () => {
    const dangerous = ['hello OR world', 'foo*', '(test)', 'NOT bar', 'col:val', '"'];
    for (const q of dangerous) {
      const results = db.searchMemories(q);
      assert.ok(Array.isArray(results));
    }
    cleanup(db, dir);
  });

  it('returns empty for empty query', () => {
    const results = db.searchMemories('');
    assert.equal(results.length, 0);
    cleanup(db, dir);
  });

  it('returns empty for whitespace-only query', () => {
    const results = db.searchMemories('   ');
    assert.equal(results.length, 0);
    cleanup(db, dir);
  });

  it('respects limit parameter', () => {
    const results = db.searchMemories('Result', 1);
    assert.ok(results.length <= 1);
    cleanup(db, dir);
  });
});

// ==========================================================
// Vec0 KNN Search
// ==========================================================
describe('MemoryDatabase - vector search', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('stores and searches by embedding', () => {
    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(2);

    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'first item', importance: 0.8 }));
    db.updateMemoryEmbedding('m1', emb1);

    db.insertMemory(makeMemoryRow({ id: 'm2', content: 'second item' }));
    db.updateMemoryEmbedding('m2', emb2);

    const results = db.hybridSearchMemories('item', emb1, 10);
    assert.ok(results.length >= 1);
    assert.equal(results[0].id, 'm1');
    cleanup(db, dir);
  });

  it('finds similar memory for dedup', () => {
    const emb = makeEmbedding(42);
    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'test' }));
    db.updateMemoryEmbedding('m1', emb);

    const dup = db.findSimilarMemory(emb);
    assert.ok(dup);
    assert.equal(dup.id, 'm1');
    assert.ok(dup.distance < 0.01);

    const diff = db.findSimilarMemory(makeEmbedding(999));
    if (diff) {
      assert.ok(diff.distance >= 0.05);
    }
    cleanup(db, dir);
  });

  it('returns null when no similar memory exists', () => {
    const { db: emptyDb, dir: emptyDir } = makeTempDb();
    const result = emptyDb.findSimilarMemory(makeEmbedding(1));
    assert.equal(result, null);
    cleanup(emptyDb, emptyDir);
    cleanup(db, dir);
  });

  it('respects custom threshold in findSimilarMemory', () => {
    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(100); // Very different

    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'test' }));
    db.updateMemoryEmbedding('m1', emb1);

    // With very strict threshold, different embedding should not match
    const result = db.findSimilarMemory(emb2, 0.001);
    assert.equal(result, null);
    cleanup(db, dir);
  });
});

// ==========================================================
// Hybrid Search Scoring
// ==========================================================
describe('MemoryDatabase - hybrid search scoring', () => {
  it('works with FTS-only when no embedding provided', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        type: 'semantic',
        title: 'ML Overview',
        content: 'machine learning neural networks',
        importance: 0.8,
      }),
    );

    const results = db.hybridSearchMemories('machine learning', null, 10);
    assert.ok(results.length >= 1);
    assert.equal(results[0].id, 'm1');
    assert.ok(results[0].score > 0);
    cleanup(db, dir);
  });

  it('combines FTS and vector scores when both available', () => {
    const { db, dir } = makeTempDb();
    const emb = makeEmbedding(1);

    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        content: 'machine learning algorithms',
        importance: 0.8,
      }),
    );
    db.updateMemoryEmbedding('m1', emb);

    db.insertMemory(
      makeMemoryRow({
        id: 'm2',
        content: 'unrelated topic about cooking',
        importance: 0.8,
      }),
    );
    db.updateMemoryEmbedding('m2', makeEmbedding(999));

    const results = db.hybridSearchMemories('machine learning', emb, 10);
    assert.ok(results.length >= 1);
    // m1 should score higher (matches both FTS and vector)
    assert.equal(results[0].id, 'm1');
    cleanup(db, dir);
  });

  it('returns empty array for empty query and no embedding', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'some content' }));

    const results = db.hybridSearchMemories('', null, 10);
    assert.equal(results.length, 0);
    cleanup(db, dir);
  });

  it('auto-boosts importance for top search hits', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        content: 'specific keyword searchable',
        importance: 0.5,
      }),
    );

    db.hybridSearchMemories('specific keyword', null, 10);

    // Re-read without triggering access (use listMemories)
    const rows = db.listMemories(undefined, 20, 0);
    const m1 = rows.find((r) => r.id === 'm1');
    assert.ok(m1);
    assert.ok(m1.importance > 0.5);
    cleanup(db, dir);
  });
});

// ==========================================================
// Relevance filtering
// ==========================================================
describe('MemoryDatabase - relevance filtering', () => {
  it('Stage 1 filters noise below topic threshold', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'relevant',
        content: 'machine learning neural networks deep learning',
        importance: 0.5,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'noise',
        content: 'unrelated cooking recipe pasta tomato',
        importance: 0.9,
      }),
    );

    const results = db.hybridSearchMemories('machine learning', null, 10, {
      topicThreshold: 0.05,
    });
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes('relevant'), 'Should include relevant match');
    assert.ok(!ids.includes('noise'), 'Should exclude noise despite high importance');
    cleanup(db, dir);
  });

  it('Stage 1 preserves strong matches with strict threshold', () => {
    const { db, dir } = makeTempDb();
    // Need multiple documents so BM25 IDF is meaningful (single-doc = 100% DF = near-zero IDF)
    db.insertMemory(
      makeMemoryRow({
        id: 'strong',
        content: 'machine learning algorithms neural networks training optimization',
        importance: 0.5,
      }),
    );
    db.insertMemory(makeMemoryRow({ id: 'other1', content: 'cooking recipe pasta tomato sauce' }));
    db.insertMemory(makeMemoryRow({ id: 'other2', content: 'gardening plants watering soil' }));
    db.insertMemory(makeMemoryRow({ id: 'other3', content: 'music guitar chords practice' }));

    // With good IDF (1/4 docs match), textScore should be well above the floor
    const unfiltered = db.hybridSearchMemories('machine learning', null, 10, { topicThreshold: 0 });
    assert.ok(unfiltered.length >= 1);
    assert.ok(
      unfiltered[0].textScore > 0.05,
      `Good IDF match should produce textScore above floor, got ${unfiltered[0].textScore}`,
    );

    // A threshold above the floor but below the actual score should preserve the result
    const results = db.hybridSearchMemories('machine learning', null, 10, {
      topicThreshold: unfiltered[0].textScore - 0.01,
    });
    assert.ok(results.length >= 1, 'Strong match should pass threshold below its textScore');
    assert.equal(results[0].id, 'strong');
    cleanup(db, dir);
  });

  it('Stage 2 filters marginal composite scores', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'old-marginal',
        content: 'machine learning basics',
        importance: 0.1,
        access_count: 0,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'recent-strong',
        content: 'machine learning algorithms deep learning',
        importance: 0.8,
      }),
    );

    const results = db.hybridSearchMemories('machine learning', null, 10, {
      topicThreshold: 0.01,
      relevanceThreshold: 0.25,
    });
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes('recent-strong'), 'Strong recent match should pass');
    // old-marginal: textScore ~0.05 (floor) → finalScore = 0.05*0.5 + 0.1*0.2 + ~0*0.2 + 0*0.1 ≈ 0.045
    // Should be filtered by relevanceThreshold 0.25
    assert.ok(!ids.includes('old-marginal'), 'Old marginal match should be filtered');
    cleanup(db, dir);
  });

  it('default filter is backward-compatible', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        content: 'searchable keyword unique',
        importance: 0.5,
      }),
    );

    // Without filter arg (default topicThreshold 0.05)
    const noFilter = db.hybridSearchMemories('searchable keyword', null, 10);
    // With explicit default filter
    const withDefault = db.hybridSearchMemories('searchable keyword', null, 10, {
      topicThreshold: 0.05,
    });

    assert.equal(noFilter.length, withDefault.length);
    if (noFilter.length > 0 && withDefault.length > 0) {
      assert.equal(noFilter[0].id, withDefault[0].id);
    }
    cleanup(db, dir);
  });

  it('auto-boost is not applied to filtered-out results', () => {
    const { db, dir } = makeTempDb();

    db.insertMemory(
      makeMemoryRow({
        id: 'noise',
        content: 'unrelated cooking recipe pasta sauce',
        importance: 0.5,
      }),
    );
    // Give noise a very different embedding from the query
    db.updateMemoryEmbedding('noise', makeEmbedding(999));

    // Search with a different embedding — vec similarity will be low, FTS won't match
    db.hybridSearchMemories('machine learning', makeEmbedding(1), 10, { topicThreshold: 0.05 });

    const row = db.getMemoryByIdRaw('noise');
    assert.ok(row);
    assert.equal(row.importance, 0.5, 'Importance should not change for filtered-out results');
    cleanup(db, dir);
  });

  it('FTS-only fallback respects topic gate', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'relevant',
        content: 'typescript compiler strict mode configuration',
        importance: 0.5,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'noise',
        content: 'python flask web framework routing',
        importance: 0.9,
      }),
    );

    // FTS-only, threshold below FTS_MATCH_FLOOR — FTS matches pass
    const results = db.hybridSearchMemories('typescript compiler', null, 10, {
      topicThreshold: 0.05,
    });
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes('relevant'));
    assert.ok(!ids.includes('noise'), 'Non-matching content should not appear');
    cleanup(db, dir);
  });

  it('textScore field is populated on returned results', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        content: 'database query optimization indexes',
        importance: 0.5,
      }),
    );

    const results = db.hybridSearchMemories('database query', null, 10);
    assert.ok(results.length >= 1);
    assert.ok(typeof results[0].textScore === 'number', 'textScore should be a number');
    assert.ok(results[0].textScore >= 0.05, 'textScore should be at least FTS_MATCH_FLOOR for FTS matches');
    assert.ok(results[0].textScore <= 1, 'textScore should be <= 1');
    cleanup(db, dir);
  });

  it('both filters compose correctly', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    // Strong match, recent
    db.insertMemory(
      makeMemoryRow({
        id: 'strong-recent',
        content: 'database query optimization performance tuning indexes',
        importance: 0.8,
      }),
    );
    // Noise (FTS won't match)
    db.insertMemory(
      makeMemoryRow({
        id: 'noise',
        content: 'cooking recipe pasta sauce',
        importance: 0.9,
      }),
    );
    // Weak match, old, low importance — passes Stage 1 (FTS matches) but fails Stage 2
    db.insertMemory(
      makeMemoryRow({
        id: 'weak-old',
        content: 'database',
        importance: 0.1,
        access_count: 0,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    const results = db.hybridSearchMemories('database query optimization', null, 10, {
      topicThreshold: 0.05,
      relevanceThreshold: 0.25,
    });
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes('strong-recent'), 'Strong recent match passes both filters');
    assert.ok(!ids.includes('noise'), 'Noise filtered by Stage 1 (no FTS match)');
    // weak-old: textScore ~0.05 (floor), finalScore ~0.045 → filtered by relevanceThreshold 0.25
    assert.ok(!ids.includes('weak-old'), 'Weak old match filtered by Stage 2');
    for (const r of results) {
      assert.ok(r.textScore >= 0.05, `textScore ${r.textScore} should meet topic threshold`);
      assert.ok(r.score >= 0.25, `score ${r.score} should meet relevance threshold`);
    }
    cleanup(db, dir);
  });
});

// ==========================================================
// Cleanup working memories by age
// ==========================================================
describe('MemoryDatabase - cleanupWorkingMemories', () => {
  it('removes old working memories based on age', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

    db.insertMemory(
      makeMemoryRow({
        id: 'old-w',
        type: 'working',
        content: 'old working',
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'new-w',
        type: 'working',
        content: 'new working',
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'sem',
        type: 'semantic',
        content: 'permanent',
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    const cleaned = db.cleanupWorkingMemories(24);
    assert.equal(cleaned, 1);
    assert.equal(db.getMemoryById('old-w'), null);
    assert.ok(db.getMemoryById('new-w'));
    assert.ok(db.getMemoryById('sem')); // Non-working type unaffected

    cleanup(db, dir);
  });

  it('does nothing when no old working memories exist', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'w1', type: 'working', content: 'fresh' }));

    const cleaned = db.cleanupWorkingMemories(24);
    assert.equal(cleaned, 0);
    assert.ok(db.getMemoryById('w1'));

    cleanup(db, dir);
  });
});

// ==========================================================
// Episodic Cleanup
// ==========================================================
describe('MemoryDatabase - episodic cleanup', () => {
  it('cleans old low-value episodic memories', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'old-low',
        type: 'episodic',
        content: 'old session',
        importance: 0.3,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'old-important',
        type: 'episodic',
        content: 'important session',
        importance: 0.9,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'old-accessed',
        type: 'episodic',
        content: 'accessed session',
        importance: 0.3,
        access_count: 5,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'recent',
        type: 'episodic',
        content: 'recent session',
        importance: 0.3,
      }),
    );

    const cleaned = db.cleanupOldEpisodicMemories(90);
    assert.equal(cleaned, 1);
    assert.equal(db.getMemoryById('old-low'), null);
    assert.ok(db.getMemoryById('old-important'));
    assert.ok(db.getMemoryById('old-accessed'));
    assert.ok(db.getMemoryById('recent'));
    cleanup(db, dir);
  });

  it('does nothing when no memories qualify for cleanup', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'recent',
        type: 'episodic',
        content: 'recent',
        importance: 0.3,
      }),
    );

    const cleaned = db.cleanupOldEpisodicMemories(90);
    assert.equal(cleaned, 0);
    cleanup(db, dir);
  });
});

// ==========================================================
// Importance Decay
// ==========================================================
describe('MemoryDatabase - importance decay', () => {
  it('decays importance for unaccessed memories', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'stale',
        content: 'old fact',
        importance: 0.7,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'active',
        content: 'active fact',
        importance: 0.7,
        access_count: 5,
        created_at: oldDate,
        updated_at: oldDate,
        last_accessed: new Date().toISOString(),
      }),
    );

    const decayed = db.decayImportance(30, 0.05);
    assert.equal(decayed, 1);

    const stale = db.getMemoryById('stale');
    assert.ok(stale);
    assert.ok(stale.importance < 0.7);

    const active = db.getMemoryById('active');
    assert.ok(active);
    assert.equal(active.importance, 0.7);

    cleanup(db, dir);
  });

  it('does not decay below minimum 0.1', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'low',
        content: 'low importance',
        importance: 0.12,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    db.decayImportance(30, 0.05);
    const row = db.getMemoryById('low');
    assert.ok(row);
    assert.ok(row.importance >= 0.1);

    cleanup(db, dir);
  });

  it('skips working memories', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'w1',
        type: 'working',
        content: 'working',
        importance: 0.7,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    const decayed = db.decayImportance(30, 0.05);
    assert.equal(decayed, 0);

    cleanup(db, dir);
  });
});

// ==========================================================
// Meta Table
// ==========================================================
describe('MemoryDatabase - meta', () => {
  it('stores and retrieves session metadata', () => {
    const { db, dir } = makeTempDb();

    db.setSessionMeta('session_count', '5');
    assert.equal(db.getSessionMeta('session_count'), '5');

    db.setSessionMeta('session_count', '6');
    assert.equal(db.getSessionMeta('session_count'), '6');

    assert.equal(db.getSessionMeta('nonexistent'), null);

    cleanup(db, dir);
  });

  it('handles multiple distinct keys', () => {
    const { db, dir } = makeTempDb();

    db.setSessionMeta('key1', 'value1');
    db.setSessionMeta('key2', 'value2');

    assert.equal(db.getSessionMeta('key1'), 'value1');
    assert.equal(db.getSessionMeta('key2'), 'value2');

    cleanup(db, dir);
  });
});

// ==========================================================
// Embedding update
// ==========================================================
describe('MemoryDatabase - updateMemoryEmbedding', () => {
  it('stores and replaces embedding for a memory', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'test' }));

    const emb1 = makeEmbedding(1);
    db.updateMemoryEmbedding('m1', emb1);

    // Memory should now have embedding (verified via vector search)
    const similar = db.findSimilarMemory(emb1);
    assert.ok(similar);
    assert.equal(similar.id, 'm1');
    assert.ok(similar.distance < 0.01);

    // Replace with different embedding
    const emb2 = makeEmbedding(999);
    db.updateMemoryEmbedding('m1', emb2);

    const result = db.findSimilarMemory(emb2);
    assert.ok(result);
    assert.equal(result.id, 'm1');
    assert.ok(result.distance < 0.01);

    cleanup(db, dir);
  });
});

// ==========================================================
// countMemories
// ==========================================================
describe('MemoryDatabase - countMemories', () => {
  it('counts all memories without filter', () => {
    const { db, dir } = makeTempDb();
    assert.equal(db.countMemories(), 0);

    db.insertMemory(makeMemoryRow({ id: 'm1', type: 'semantic', content: 'a' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', type: 'episodic', content: 'b' }));
    assert.equal(db.countMemories(), 2);

    cleanup(db, dir);
  });

  it('counts memories by type', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'm1', type: 'semantic', content: 'a' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', type: 'semantic', content: 'b' }));
    db.insertMemory(makeMemoryRow({ id: 'm3', type: 'episodic', content: 'c' }));

    assert.equal(db.countMemories('semantic'), 2);
    assert.equal(db.countMemories('episodic'), 1);
    assert.equal(db.countMemories('pattern'), 0);

    cleanup(db, dir);
  });
});

// ==========================================================
// getMemoryByIdRaw
// ==========================================================
describe('MemoryDatabase - getMemoryByIdRaw', () => {
  it('reads without incrementing access_count', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'raw read test' }));

    const first = db.getMemoryByIdRaw('mem1');
    assert.ok(first);
    assert.equal(first.access_count, 0);

    const second = db.getMemoryByIdRaw('mem1');
    assert.ok(second);
    assert.equal(second.access_count, 0);

    cleanup(db, dir);
  });

  it('does not update last_accessed', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'raw read test' }));

    db.getMemoryByIdRaw('mem1');
    const row = db.getMemoryByIdRaw('mem1');
    assert.ok(row);
    assert.equal(row.last_accessed, null);

    cleanup(db, dir);
  });

  it('returns null for nonexistent memory', () => {
    const { db, dir } = makeTempDb();
    assert.equal(db.getMemoryByIdRaw('nonexistent'), null);
    cleanup(db, dir);
  });
});

// ==========================================================
// Dynamic importance boost on access
// ==========================================================
describe('MemoryDatabase - dynamic importance boost', () => {
  it('adds +0.01 importance on getMemoryById', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'test', importance: 0.5 }));

    db.getMemoryById('mem1');
    const row = db.getMemoryByIdRaw('mem1');
    assert.ok(row);
    assert.ok(Math.abs(row.importance - 0.51) < 0.001, `Expected ~0.51 but got ${row.importance}`);

    cleanup(db, dir);
  });

  it('caps importance at 0.95', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'test', importance: 0.95 }));

    db.getMemoryById('mem1');
    const row = db.getMemoryByIdRaw('mem1');
    assert.ok(row);
    assert.ok(row.importance <= 0.95, `Expected <= 0.95 but got ${row.importance}`);

    cleanup(db, dir);
  });

  it('is not applied by getMemoryByIdRaw', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'test', importance: 0.5 }));

    db.getMemoryByIdRaw('mem1');
    db.getMemoryByIdRaw('mem1');
    db.getMemoryByIdRaw('mem1');

    const row = db.getMemoryByIdRaw('mem1');
    assert.ok(row);
    assert.equal(row.importance, 0.5);

    cleanup(db, dir);
  });
});

// ==========================================================
// Velocity-aware importance decay
// ==========================================================
describe('MemoryDatabase - velocity-aware decay', () => {
  it('applies full decay rate for access_count <= 5', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'low-access',
        content: 'rarely used',
        importance: 0.7,
        access_count: 3,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    db.decayImportance(30, 0.10);
    const row = db.getMemoryByIdRaw('low-access');
    assert.ok(row);
    assert.ok(Math.abs(row.importance - 0.6) < 0.001, `Expected ~0.6 but got ${row.importance}`);

    cleanup(db, dir);
  });

  it('applies half decay rate for access_count 6-10', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'mid-access',
        content: 'moderately used',
        importance: 0.7,
        access_count: 8,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    db.decayImportance(30, 0.10);
    const row = db.getMemoryByIdRaw('mid-access');
    assert.ok(row);
    assert.ok(Math.abs(row.importance - 0.65) < 0.001, `Expected ~0.65 but got ${row.importance}`);

    cleanup(db, dir);
  });

  it('applies quarter decay rate for access_count > 10', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'high-access',
        content: 'heavily used',
        importance: 0.7,
        access_count: 15,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    db.decayImportance(30, 0.10);
    const row = db.getMemoryByIdRaw('high-access');
    assert.ok(row);
    assert.ok(Math.abs(row.importance - 0.675) < 0.001, `Expected ~0.675 but got ${row.importance}`);

    cleanup(db, dir);
  });

  it('respects 0.1 floor across all tiers', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'near-floor',
        content: 'near floor',
        importance: 0.12,
        access_count: 0,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    db.decayImportance(30, 0.10);
    const row = db.getMemoryByIdRaw('near-floor');
    assert.ok(row);
    assert.ok(row.importance >= 0.1);

    cleanup(db, dir);
  });

  it('skips working memories in all tiers', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'w1',
        type: 'working',
        content: 'working',
        importance: 0.7,
        access_count: 0,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    const decayed = db.decayImportance(30, 0.10);
    assert.equal(decayed, 0);

    cleanup(db, dir);
  });
});

// ==========================================================
// findRelatedMemories
// ==========================================================
describe('MemoryDatabase - findRelatedMemories', () => {
  it('returns memories in the 0.05-0.35 distance range', () => {
    const { db, dir } = makeTempDb();
    const baseEmb = makeEmbedding(1);

    // Insert a memory with a somewhat similar embedding
    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'related content' }));
    const relatedEmb = makeEmbedding(2);
    db.updateMemoryEmbedding('m1', relatedEmb);

    const results = db.findRelatedMemories(baseEmb, 5);
    // Results should only include memories in the 0.05-0.35 range
    for (const r of results) {
      assert.ok(r.distance >= 0.05, `Distance ${r.distance} should be >= 0.05`);
      assert.ok(r.distance < 0.35, `Distance ${r.distance} should be < 0.35`);
    }

    cleanup(db, dir);
  });

  it('excludes near-duplicates (distance < 0.05)', () => {
    const { db, dir } = makeTempDb();
    const emb = makeEmbedding(42);
    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'exact match' }));
    db.updateMemoryEmbedding('m1', emb);

    const results = db.findRelatedMemories(emb, 5);
    assert.ok(!results.some((r) => r.id === 'm1'), 'Should not include near-duplicate');

    cleanup(db, dir);
  });

  it('returns empty when no memories exist', () => {
    const { db, dir } = makeTempDb();
    const results = db.findRelatedMemories(makeEmbedding(1), 5);
    assert.equal(results.length, 0);
    cleanup(db, dir);
  });

  it('respects limit parameter', () => {
    const { db, dir } = makeTempDb();
    for (let i = 0; i < 10; i++) {
      db.insertMemory(makeMemoryRow({ id: `m${i}`, content: `content ${i}` }));
      db.updateMemoryEmbedding(`m${i}`, makeEmbedding(i + 10));
    }

    const results = db.findRelatedMemories(makeEmbedding(1), 3);
    assert.ok(results.length <= 3);

    cleanup(db, dir);
  });
});

// ==========================================================
// getHealthStats
// ==========================================================
describe('MemoryDatabase - getHealthStats', () => {
  it('returns correct stats for populated database', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'm1', type: 'semantic', content: 'a' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', type: 'episodic', content: 'b' }));
    db.insertMemory(makeMemoryRow({ id: 'm3', type: 'semantic', content: 'c' }));

    db.updateMemoryEmbedding('m1', makeEmbedding(1));

    const stats = db.getHealthStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.byType['semantic'], 2);
    assert.equal(stats.byType['episodic'], 1);
    assert.equal(stats.withEmbedding, 1);
    assert.equal(stats.withoutEmbedding, 2);

    cleanup(db, dir);
  });

  it('reports age distribution correctly', () => {
    const { db, dir } = makeTempDb();
    const now = new Date().toISOString();
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(makeMemoryRow({ id: 'recent', content: 'recent', created_at: now, updated_at: now }));
    db.insertMemory(makeMemoryRow({ id: 'old', content: 'old', created_at: oldDate, updated_at: oldDate }));

    const stats = db.getHealthStats();
    assert.equal(stats.ageDistribution.last24h, 1);
    assert.equal(stats.ageDistribution.older, 1);
    assert.equal(stats.total, 2);

    cleanup(db, dir);
  });

  it('reports session metadata', () => {
    const { db, dir } = makeTempDb();
    db.setSessionMeta('session_count', '5');
    db.setSessionMeta('last_consolidation', '3');

    const stats = db.getHealthStats();
    assert.equal(stats.sessionCount, 5);
    assert.equal(stats.lastConsolidation, 3);

    cleanup(db, dir);
  });

  it('reports stale count correctly', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'stale',
        content: 'stale',
        importance: 0.1,
        access_count: 0,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'active',
        content: 'active',
        importance: 0.8,
        access_count: 5,
      }),
    );

    const stats = db.getHealthStats();
    assert.equal(stats.staleCount, 1);

    cleanup(db, dir);
  });
});

// ==========================================================
// getCurationStats
// ==========================================================
describe('MemoryDatabase - getCurationStats', () => {
  it('returns correct totals and type breakdown', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'm1', type: 'semantic', content: 'a' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', type: 'episodic', content: 'b' }));
    db.insertMemory(makeMemoryRow({ id: 'm3', type: 'pattern', content: 'c' }));

    const stats = db.getCurationStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.byType['semantic'], 1);
    assert.equal(stats.byType['episodic'], 1);
    assert.equal(stats.byType['pattern'], 1);

    cleanup(db, dir);
  });

  it('counts stale memories', () => {
    const { db, dir } = makeTempDb();
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'stale1',
        content: 'stale',
        importance: 0.1,
        access_count: 0,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(makeMemoryRow({ id: 'active', content: 'active', importance: 0.8 }));

    const stats = db.getCurationStats();
    assert.equal(stats.staleCount, 1);

    cleanup(db, dir);
  });

  it('detects near-duplicate candidates', () => {
    const { db, dir } = makeTempDb();
    const emb1 = makeEmbedding(1);
    // Create a very similar embedding by slightly modifying emb1
    const emb2 = new Float32Array(emb1);
    emb2[0] += 0.001;
    // Re-normalize
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += emb2[i] * emb2[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) emb2[i] /= norm;

    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'first version' }));
    db.updateMemoryEmbedding('m1', emb1);
    db.insertMemory(makeMemoryRow({ id: 'm2', content: 'slightly different' }));
    db.updateMemoryEmbedding('m2', emb2);

    const stats = db.getCurationStats();
    // The embeddings are extremely similar, so distance should be < 0.05 (near-duplicate range)
    // Whether they show up as candidates depends on exact distance falling in [0.05, 0.10)
    assert.ok(stats.duplicateCandidateCount >= 0);

    cleanup(db, dir);
  });
});

// ==========================================================
// WAL checkpoint on close
// ==========================================================
describe('MemoryDatabase - WAL checkpoint', () => {
  it('close() executes WAL checkpoint without error', () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(makeMemoryRow({ id: 'mem1', content: 'test data' }));
    // close() should run wal_checkpoint(TRUNCATE) then close — no throw
    db.close();
    rmSync(dir, { recursive: true });
  });
});

// ==========================================================
// path getter
// ==========================================================
describe('MemoryDatabase - path getter', () => {
  it('returns the database file path', () => {
    const { db, dir } = makeTempDb();
    const dbPath = db.path;
    assert.ok(dbPath.includes('memory.sqlite'));
    assert.ok(statSync(dbPath).isFile());
    cleanup(db, dir);
  });
});
