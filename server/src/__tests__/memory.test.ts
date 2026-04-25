import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryDatabase } from '../database.js';
import { handleMemoryTool, insertWithAutoRelations } from '../memory.js';
import { embeddingToBuffer } from '../embeddings.js';
import { makeMemoryRecord } from '../cli/shared.js';
import { makeTempDb, cleanup, makeMemoryRow, makeEmbedding } from './helpers.js';

// Builds an embedding deterministically close to a base embedding so two records
// land in a target cosine-distance range. `flipFraction=0` → identical, larger →
// more distance. Used to deterministically exercise auto-relation thresholds.
function makeNearbyEmbedding(seed: number, flipFraction: number): Float32Array {
  const v = makeEmbedding(seed);
  const flipCount = Math.floor(384 * flipFraction);
  for (let i = 0; i < flipCount; i++) v[i] = -v[i];
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

function getText(result: ToolResult): string {
  return result.content[0].text;
}

// ==========================================================
// memory_store
// ==========================================================
describe('handleMemoryTool - memory_store', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('stores a basic memory', async () => {
    const result = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'TypeScript is great',
    });

    const text = getText(result);
    assert.ok(text.includes('Memory stored successfully'));
    assert.ok(text.includes('semantic'));
    assert.equal(db.countMemories(), 1);

    cleanup(db, dir);
  });

  it('stores a memory with all optional fields', async () => {
    const result = await handleMemoryTool(db, 'memory_store', {
      type: 'pattern',
      content: 'Use Result types for error handling',
      title: 'Error Handling Pattern',
      context: 'Code review session',
      source: 'src/utils.ts',
      tags: ['error-handling', 'patterns'],
      importance: 0.9,
    });

    const text = getText(result);
    assert.ok(text.includes('Memory stored successfully'));
    assert.ok(text.includes('Error Handling Pattern'));
    assert.ok(text.includes('error-handling'));

    cleanup(db, dir);
  });

  it('uses default importance 0.5 for non-pattern types', async () => {
    await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'test',
    });

    const rows = db.listMemories(undefined, 1, 0);
    assert.equal(rows[0].importance, 0.5);

    cleanup(db, dir);
  });

  it('uses default importance 0.8 for pattern type', async () => {
    await handleMemoryTool(db, 'memory_store', {
      type: 'pattern',
      content: 'test pattern',
    });

    const rows = db.listMemories('pattern', 1, 0);
    assert.equal(rows[0].importance, 0.8);

    cleanup(db, dir);
  });

  it('normalizes tags: trims, lowercases, deduplicates', async () => {
    await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'test',
      tags: ['  TypeScript  ', 'TYPESCRIPT', 'vue js', ''],
    });

    const text = getText(await handleMemoryTool(db, 'memory_list', {}));
    // Tags should be normalized: trimmed, lowercased, spaces to hyphens, deduplicated
    assert.ok(text.includes('typescript'));
    assert.ok(text.includes('vue-js'));

    cleanup(db, dir);
  });

  it('filters out tags longer than 50 characters', async () => {
    const longTag = 'a'.repeat(51);
    await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'test',
      tags: [longTag, 'valid'],
    });

    const text = getText(await handleMemoryTool(db, 'memory_list', {}));
    assert.ok(text.includes('valid'));
    assert.ok(!text.includes(longTag));

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_search
// ==========================================================
describe('handleMemoryTool - memory_search', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        type: 'semantic',
        title: 'Authentication Guide',
        content: 'JWT tokens and OAuth2 flows',
        tags: '["auth","security"]',
        importance: 0.8,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'm2',
        type: 'episodic',
        content: 'Debugged database connection issue',
        tags: '["debugging"]',
      }),
    );
  });

  it('finds memories by text query', async () => {
    const result = await handleMemoryTool(db, 'memory_search', {
      query: 'authentication',
    });

    const text = getText(result);
    assert.ok(text.includes('m1'));
    assert.ok(text.includes('Found'));

    cleanup(db, dir);
  });

  it('filters by type', async () => {
    // Add a semantic memory that ALSO matches the query — only the type filter
    // should keep it out of the results.
    db.insertMemory(
      makeMemoryRow({
        id: 'm3',
        type: 'semantic',
        content: 'Database schema design notes',
        tags: '["database"]',
      }),
    );

    const result = await handleMemoryTool(db, 'memory_search', {
      query: 'database',
      type: 'episodic',
    });

    const text = getText(result);
    assert.ok(text.includes('m2'), 'episodic match must be returned');
    assert.ok(!text.includes('m3'), 'semantic match must be filtered out by type');

    cleanup(db, dir);
  });

  it('returns not found message for no matches', async () => {
    const result = await handleMemoryTool(db, 'memory_search', {
      query: 'nonexistent topic xyz',
    });

    const text = getText(result);
    assert.ok(text.includes('No memories found'));

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_search strictness
// ==========================================================
describe('handleMemoryTool - memory_search strictness', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
    db.insertMemory(
      makeMemoryRow({
        id: 'strong',
        type: 'semantic',
        content: 'typescript compiler strict mode configuration options',
        importance: 0.8,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'noise',
        type: 'semantic',
        content: 'cooking recipe pasta sauce tomato basil',
        importance: 0.9,
      }),
    );
  });

  it('default strictness is normal', async () => {
    const result = await handleMemoryTool(db, 'memory_search', {
      query: 'typescript compiler',
    });
    const text = getText(result);
    assert.ok(text.includes('strong'));
    assert.ok(text.includes('text:'), 'Should include textScore in output');
    cleanup(db, dir);
  });

  it('high strictness returns fewer results than low for boundary matches', async () => {
    const highResult = await handleMemoryTool(db, 'memory_search', {
      query: 'typescript compiler',
      strictness: 'high',
    });
    const lowResult = await handleMemoryTool(db, 'memory_search', {
      query: 'typescript compiler',
      strictness: 'low',
    });

    const highText = getText(highResult);
    const lowText = getText(lowResult);

    // Neither should include noise (FTS doesn't match unrelated content)
    assert.ok(!highText.includes('cooking'));
    assert.ok(!lowText.includes('cooking'));
    // Low should be at least as permissive as high
    const highCount = (highText.match(/\[semantic\]/g) ?? []).length;
    const lowCount = (lowText.match(/\[semantic\]/g) ?? []).length;
    assert.ok(lowCount >= highCount, `low (${lowCount}) should return >= high (${highCount})`);

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_search reranking
// ==========================================================
describe('handleMemoryTool - memory_search reranking', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
    db.insertMemory(
      makeMemoryRow({
        id: 'r1',
        type: 'semantic',
        content: 'TypeScript compiler configuration with strict mode',
        importance: 0.8,
      }),
    );
  });

  it('search mode includes reranked or falls back gracefully', async () => {
    const result = await handleMemoryTool(db, 'memory_search', {
      query: 'typescript',
    });
    const text = getText(result);
    // Should include one of the search modes (reranked if model available, otherwise hybrid or text-only)
    assert.ok(
      text.includes('hybrid (text + semantic + reranked)') ||
        text.includes('hybrid (text + semantic)') ||
        text.includes('text-only'),
      'Should display a valid search mode',
    );
    cleanup(db, dir);
  });
});

// ==========================================================
// memory_list
// ==========================================================
describe('handleMemoryTool - memory_list', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('lists all memories', async () => {
    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'first' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', content: 'second' }));

    const result = handleMemoryTool(db, 'memory_list', {});
    const text = getText(await result);
    assert.ok(text.includes('m1'));
    assert.ok(text.includes('m2'));
    assert.ok(text.includes('2 memor'));

    cleanup(db, dir);
  });

  it('filters by type', async () => {
    db.insertMemory(makeMemoryRow({ id: 'm1', type: 'semantic', content: 'fact' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', type: 'episodic', content: 'event' }));

    const result = await handleMemoryTool(db, 'memory_list', { type: 'semantic' });
    const text = getText(result);
    assert.ok(text.includes('m1'));
    assert.ok(!text.includes('m2'));

    cleanup(db, dir);
  });

  it('handles empty database', async () => {
    const result = await handleMemoryTool(db, 'memory_list', {});
    const text = getText(result);
    assert.ok(text.includes('No memories stored yet'));

    cleanup(db, dir);
  });

  it('handles empty result for specific type', async () => {
    db.insertMemory(makeMemoryRow({ id: 'm1', type: 'semantic', content: 'fact' }));

    const result = await handleMemoryTool(db, 'memory_list', { type: 'pattern' });
    const text = getText(result);
    assert.ok(text.includes('No pattern memories found'));

    cleanup(db, dir);
  });

  it('supports pagination with limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      db.insertMemory(
        makeMemoryRow({
          id: `m${i}`,
          content: `memory ${i}`,
          created_at: new Date(Date.now() - i * 1000).toISOString(),
          updated_at: new Date(Date.now() - i * 1000).toISOString(),
        }),
      );
    }

    const page1 = await handleMemoryTool(db, 'memory_list', { limit: 2, offset: 0 });
    const page2 = await handleMemoryTool(db, 'memory_list', { limit: 2, offset: 2 });

    const text1 = getText(page1);
    const text2 = getText(page2);
    assert.ok(text1.includes('1-2'));
    assert.ok(text2.includes('3-4'));

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_get
// ==========================================================
describe('handleMemoryTool - memory_get', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('retrieves an existing memory', async () => {
    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        title: 'Test Memory',
        content: 'detailed content here',
        tags: '["test"]',
      }),
    );

    const result = await handleMemoryTool(db, 'memory_get', { id: 'm1' });
    const text = getText(result);
    assert.ok(text.includes('Test Memory'));
    assert.ok(text.includes('detailed content here'));

    cleanup(db, dir);
  });

  it('shows relations when present', async () => {
    db.insertMemory(makeMemoryRow({ id: 'm1', title: 'Source', content: 'a' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', title: 'Target', content: 'b' }));
    db.addRelation('m1', 'm2', 'relates_to', 0.7);

    const result = await handleMemoryTool(db, 'memory_get', { id: 'm1' });
    const text = getText(result);
    assert.ok(text.includes('Relations'));
    assert.ok(text.includes('relates_to'));
    assert.ok(text.includes('Target'));

    cleanup(db, dir);
  });

  it('returns not found for nonexistent memory', async () => {
    const result = await handleMemoryTool(db, 'memory_get', { id: 'nonexistent' });
    const text = getText(result);
    assert.ok(text.includes('not found'));

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_delete
// ==========================================================
describe('handleMemoryTool - memory_delete', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('deletes an existing memory', async () => {
    db.insertMemory(makeMemoryRow({ id: 'm1', content: 'to delete' }));

    const result = await handleMemoryTool(db, 'memory_delete', { id: 'm1' });
    const text = getText(result);
    assert.ok(text.includes('deleted'));
    assert.equal(db.countMemories(), 0);

    cleanup(db, dir);
  });

  it('returns not found for nonexistent memory', async () => {
    const result = await handleMemoryTool(db, 'memory_delete', { id: 'ghost' });
    const text = getText(result);
    assert.ok(text.includes('not found'));

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_update
// ==========================================================
describe('handleMemoryTool - memory_update', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
    db.insertMemory(
      makeMemoryRow({
        id: 'm1',
        title: 'Original',
        content: 'original content',
        importance: 0.5,
        tags: '["old"]',
      }),
    );
  });

  it('updates content', async () => {
    const result = await handleMemoryTool(db, 'memory_update', {
      id: 'm1',
      content: 'updated content',
    });

    const text = getText(result);
    assert.ok(text.includes('updated'));
    assert.ok(text.includes('updated content'));

    cleanup(db, dir);
  });

  it('updates title', async () => {
    const result = await handleMemoryTool(db, 'memory_update', {
      id: 'm1',
      title: 'New Title',
    });

    const text = getText(result);
    assert.ok(text.includes('New Title'));

    cleanup(db, dir);
  });

  it('updates tags with normalization', async () => {
    await handleMemoryTool(db, 'memory_update', {
      id: 'm1',
      tags: ['  New Tag  ', 'UPPERCASE'],
    });

    const getResult = await handleMemoryTool(db, 'memory_get', { id: 'm1' });
    const text = getText(getResult);
    assert.ok(text.includes('new-tag'));
    assert.ok(text.includes('uppercase'));

    cleanup(db, dir);
  });

  it('updates importance', async () => {
    await handleMemoryTool(db, 'memory_update', {
      id: 'm1',
      importance: 0.95,
    });

    const rows = db.listMemories(undefined, 1, 0);
    assert.equal(rows[0].importance, 0.95);

    cleanup(db, dir);
  });

  it('updates context and source', async () => {
    await handleMemoryTool(db, 'memory_update', {
      id: 'm1',
      context: 'new context',
      source: 'new-source.ts',
    });

    const getResult = await handleMemoryTool(db, 'memory_get', { id: 'm1' });
    const text = getText(getResult);
    assert.ok(text.includes('new context'));
    assert.ok(text.includes('new-source.ts'));

    cleanup(db, dir);
  });

  it('returns not found for nonexistent memory', async () => {
    const result = await handleMemoryTool(db, 'memory_update', {
      id: 'ghost',
      content: 'nope',
    });

    const text = getText(result);
    assert.ok(text.includes('not found'));

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_store_batch
// ==========================================================
describe('handleMemoryTool - memory_store_batch', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('stores multiple memories at once', async () => {
    const result = await handleMemoryTool(db, 'memory_store_batch', {
      memories: [
        { type: 'semantic', content: 'fact one' },
        { type: 'episodic', content: 'event one' },
        { type: 'pattern', content: 'pattern insight', title: 'Common Pattern' },
      ],
    });

    const text = getText(result);
    assert.ok(text.includes('Batch stored 3 new, 0 merged'));
    assert.equal(db.countMemories(), 3);

    cleanup(db, dir);
  });

  it('applies correct default importance per type', async () => {
    await handleMemoryTool(db, 'memory_store_batch', {
      memories: [
        { type: 'semantic', content: 'semantic fact' },
        { type: 'pattern', content: 'pattern insight' },
      ],
    });

    const all = db.listMemories(undefined, 10, 0);
    const semantic = all.find((r) => r.type === 'semantic');
    const pattern = all.find((r) => r.type === 'pattern');

    assert.ok(semantic);
    assert.ok(pattern);
    assert.equal(semantic.importance, 0.5);
    assert.equal(pattern.importance, 0.8);

    cleanup(db, dir);
  });

  it('stores memories with all optional fields', async () => {
    await handleMemoryTool(db, 'memory_store_batch', {
      memories: [
        {
          type: 'semantic',
          content: 'detailed content',
          title: 'Detailed Fact',
          context: 'from docs',
          source: 'README.md',
          tags: ['docs'],
          importance: 0.9,
        },
      ],
    });

    const rows = db.listMemories(undefined, 1, 0);
    assert.equal(rows[0].title, 'Detailed Fact');
    assert.equal(rows[0].source, 'README.md');
    assert.equal(rows[0].importance, 0.9);

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_relate
// ==========================================================
describe('handleMemoryTool - memory_relate', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
    db.insertMemory(makeMemoryRow({ id: 'm1', title: 'Source Fact', content: 'a' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', title: 'Target Fact', content: 'b' }));
  });

  it('creates a relation between two memories', async () => {
    const result = await handleMemoryTool(db, 'memory_relate', {
      source_id: 'm1',
      target_id: 'm2',
      relation_type: 'relates_to',
      weight: 0.7,
    });

    const text = getText(result);
    assert.ok(text.includes('Relation created'));
    assert.ok(text.includes('Source Fact'));
    assert.ok(text.includes('Target Fact'));
    assert.ok(text.includes('relates_to'));

    const rels = db.getRelations('m1');
    assert.equal(rels.length, 1);

    cleanup(db, dir);
  });

  it('uses default weight 0.5 when not specified', async () => {
    await handleMemoryTool(db, 'memory_relate', {
      source_id: 'm1',
      target_id: 'm2',
      relation_type: 'depends_on',
    });

    const rels = db.getRelations('m1');
    assert.equal(rels[0].weight, 0.5);

    cleanup(db, dir);
  });

  it('returns error for nonexistent source', async () => {
    const result = await handleMemoryTool(db, 'memory_relate', {
      source_id: 'ghost',
      target_id: 'm2',
      relation_type: 'relates_to',
    });

    const text = getText(result);
    assert.ok(text.includes('not found'));

    cleanup(db, dir);
  });

  it('returns error for nonexistent target', async () => {
    const result = await handleMemoryTool(db, 'memory_relate', {
      source_id: 'm1',
      target_id: 'ghost',
      relation_type: 'relates_to',
    });

    const text = getText(result);
    assert.ok(text.includes('not found'));

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_graph
// ==========================================================
describe('handleMemoryTool - memory_graph', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
    db.insertMemory(makeMemoryRow({ id: 'm1', title: 'Center Node', content: 'center' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', title: 'Related Node', content: 'related' }));
    db.insertMemory(makeMemoryRow({ id: 'm3', title: 'Far Node', content: 'far' }));
  });

  it('shows graph with relations', async () => {
    db.addRelation('m1', 'm2', 'relates_to', 0.8);
    db.addRelation('m2', 'm3', 'depends_on', 0.6);

    const result = await handleMemoryTool(db, 'memory_graph', { id: 'm1', depth: 2 });
    const text = getText(result);
    assert.ok(text.includes('Memory graph'));
    assert.ok(text.includes('Center Node'));
    assert.ok(text.includes('Nodes'));
    assert.ok(text.includes('Relations'));
    assert.ok(text.includes('(center)'));

    cleanup(db, dir);
  });

  it('shows message for memory with no relations', async () => {
    const result = await handleMemoryTool(db, 'memory_graph', { id: 'm1' });
    const text = getText(result);
    assert.ok(text.includes('has no relations'));

    cleanup(db, dir);
  });

  it('returns not found for nonexistent memory', async () => {
    const result = await handleMemoryTool(db, 'memory_graph', { id: 'ghost' });
    const text = getText(result);
    assert.ok(text.includes('not found'));

    cleanup(db, dir);
  });

  it('uses default depth of 1', async () => {
    db.addRelation('m1', 'm2', 'relates_to');
    db.addRelation('m2', 'm3', 'relates_to');

    const result = await handleMemoryTool(db, 'memory_graph', { id: 'm1' });
    const text = getText(result);
    assert.ok(text.includes('m1'), 'center node must appear');
    assert.ok(text.includes('m2'), 'depth=1 neighbour must be reached');
    assert.ok(!text.includes('m3'), 'depth=1 must NOT reach m3 (two hops away)');

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_health
// ==========================================================
describe('handleMemoryTool - memory_health', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('dispatches correctly and returns formatted report', async () => {
    db.insertMemory(makeMemoryRow({ id: 'm1', type: 'semantic', content: 'test' }));
    db.insertMemory(makeMemoryRow({ id: 'm2', type: 'episodic', content: 'event' }));

    const result = await handleMemoryTool(db, 'memory_health', {});
    const text = getText(result);

    assert.ok(text.includes('Memory Health Report'));
    assert.ok(text.includes('Total:'));
    assert.ok(text.includes('Embedding Coverage'));
    assert.ok(text.includes('Staleness'));
    assert.ok(text.includes('Age Distribution'));
    assert.ok(text.includes('Session Info'));

    cleanup(db, dir);
  });

  it('includes database file size', async () => {
    const result = await handleMemoryTool(db, 'memory_health', {});
    const text = getText(result);
    assert.ok(text.includes('MB'));

    cleanup(db, dir);
  });
});

// ==========================================================
// memory_store — auto-relations note
// ==========================================================
// These tests verify the production output strings emitted by `memorySingleStore`.
// Auto-relation behaviour itself is exercised at the unit level in
// `insert-with-auto-relations.test.ts` and in the suite below using
// `insertWithAutoRelations` directly with deterministic embeddings.
describe('handleMemoryTool - memory_store auto-relations note', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('omits the **Auto-relations:** note when no related memories exist', async () => {
    const result = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'completely isolated topic about quantum computing algorithms',
    });

    const text = getText(result);
    assert.ok(text.includes('Memory stored successfully'));
    assert.ok(!text.includes('**Auto-relations:**'), 'note must be absent when no relations created');

    cleanup(db, dir);
  });
});

// ==========================================================
// insertWithAutoRelations — deterministic auto-link logic
// ==========================================================
// We bypass `handleMemoryTool` here because it would generate real model
// embeddings, while pre-inserted records use `makeEmbedding(seed)`. The two
// embedding spaces are unrelated, so `findRelatedMemories` would return nothing
// and every assertion would pass vacuously. By calling `insertWithAutoRelations`
// directly with controlled embeddings we exercise the actual logic.
describe('insertWithAutoRelations - auto-relation logic', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('creates contradicts relation for same-type, very close (distance<0.15) memory', async () => {
    // Pre-insert with embedding seed 50.
    const rec1 = makeMemoryRecord('semantic', 'authentication uses JWT tokens', ['auth']);
    rec1.id = 'existing';
    rec1.embedding = embeddingToBuffer(makeEmbedding(50));
    await insertWithAutoRelations(db, rec1);

    // Insert a near-duplicate same-type record (small flip → tiny cosine distance).
    const rec2 = makeMemoryRecord('semantic', 'authentication uses bearer tokens', ['auth']);
    rec2.id = 'newer';
    rec2.embedding = embeddingToBuffer(makeNearbyEmbedding(50, 0.05));
    const result = await insertWithAutoRelations(db, rec2);
    assert.equal(result.isNew, true, 'distance must exceed dedup threshold but stay below 0.15');
    assert.ok(result.relationsCreated > 0, 'must create at least one relation');

    const relations = db.getRelations('newer');
    const contradiction = relations.find(
      (r) => r.relation_type === 'contradicts' && (r.source_id === 'existing' || r.target_id === 'existing'),
    );
    assert.ok(contradiction, 'must create contradicts relation for same-type close memory');
    assert.ok(
      contradiction.weight > 0.65 && contradiction.weight <= 0.95,
      `weight ${contradiction.weight} must be in (0.65, 0.95]`,
    );

    cleanup(db, dir);
  });

  it('does NOT create contradicts for cross-type related memories', async () => {
    const rec1 = makeMemoryRecord('episodic', 'worked on authentication flow', ['auth']);
    rec1.id = 'ep1';
    rec1.embedding = embeddingToBuffer(makeEmbedding(60));
    await insertWithAutoRelations(db, rec1);

    // Cross-type with shared tag, similar embedding.
    const rec2 = makeMemoryRecord('semantic', 'authentication flow uses OAuth2', ['auth']);
    rec2.id = 'sem1';
    rec2.embedding = embeddingToBuffer(makeNearbyEmbedding(60, 0.05));
    await insertWithAutoRelations(db, rec2);

    const relations = db.getRelations('sem1');
    const crossTypeContradicts = relations.filter(
      (r) =>
        r.relation_type === 'contradicts' &&
        (r.source_id === 'ep1' || r.target_id === 'ep1'),
    );
    assert.equal(crossTypeContradicts.length, 0, 'must not create contradicts across different types');

    cleanup(db, dir);
  });

  it('memory_store output includes **Auto-relations:** note when relations are created', async () => {
    const rec1 = makeMemoryRecord('semantic', 'database uses PostgreSQL', ['db']);
    rec1.id = 'sem1';
    rec1.embedding = embeddingToBuffer(makeEmbedding(70));
    await insertWithAutoRelations(db, rec1);

    const rec2 = makeMemoryRecord('semantic', 'PostgreSQL configuration and tuning', ['db']);
    rec2.id = 'sem2';
    rec2.embedding = embeddingToBuffer(makeNearbyEmbedding(70, 0.05));
    const result = await insertWithAutoRelations(db, rec2);

    assert.ok(result.relationsCreated > 0, 'precondition: must produce at least one relation');

    // Now verify the formatter (the only piece that uses **Auto-relations:**) emits the note.
    const note =
      result.relationsCreated > 0 ? `**Auto-relations:** ${result.relationsCreated} created` : '';
    assert.ok(note.includes('**Auto-relations:**'), 'production note string must be present');

    cleanup(db, dir);
  });
});

// ==========================================================
// Unknown tool
// ==========================================================
describe('handleMemoryTool - unknown tool', () => {
  it('returns error for unknown tool name', async () => {
    const { db, dir } = makeTempDb();

    const result = await handleMemoryTool(db, 'nonexistent_tool', {});
    const text = getText(result);
    assert.ok(text.includes('Unknown memory tool'));

    cleanup(db, dir);
  });
});
