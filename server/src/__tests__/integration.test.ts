/**
 * Full integration test — exercises the entire plugin pipeline with real HF embeddings.
 * Measures timing for each operation to catch hangs/slowdowns.
 *
 * Run: npx tsx src/__tests__/integration.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleMemoryTool, resetBackfillFlag } from '../memory.js';
import { generateEmbedding, isEmbeddingsAvailable } from '../embeddings.js';
import { makeTempDb, cleanup, makeMemoryRow } from './helpers.js';
import type { MemoryDatabase } from '../database.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

function getText(result: ToolResult): string {
  return result.content[0].text;
}

function extractId(text: string): string {
  const match = text.match(/\*\*ID:\*\*\s+(\S+)/);
  assert.ok(match, `Could not extract ID from: ${text}`);
  return match[1];
}

function extractBatchIds(text: string): string[] {
  const match = text.match(/\*\*IDs:\*\*\s+(.+)/);
  assert.ok(match, `Could not extract IDs from: ${text}`);
  return match[1].split(',').map((s) => s.trim());
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`  [${elapsed}ms] ${label}`);
  return result;
}

// ==========================================================
// 1. Embedding Model Loading
// ==========================================================
describe('Integration: Embedding Model', { timeout: 120_000 }, () => {
  it('loads the HF model and generates an embedding', async () => {
    const available = await timed('isEmbeddingsAvailable()', () => isEmbeddingsAvailable());
    assert.ok(available, 'Embeddings model should be available');

    const embedding = await timed('generateEmbedding()', () =>
      generateEmbedding('test embedding generation'),
    );
    assert.ok(embedding, 'Should produce an embedding');
    assert.equal(embedding.length, 384, 'Should be 384-dimensional');

    // Verify it's normalized (magnitude ~1.0)
    let mag = 0;
    for (let i = 0; i < embedding.length; i++) mag += embedding[i] * embedding[i];
    assert.ok(Math.abs(Math.sqrt(mag) - 1.0) < 0.01, 'Embedding should be normalized');
  });
});

// ==========================================================
// 2. Full Lifecycle with Real Embeddings
// ==========================================================
describe('Integration: Full Lifecycle', { timeout: 120_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('store → search → get → update → delete with real embeddings', async () => {
    // Store
    const storeResult = await timed('memory_store', () =>
      handleMemoryTool(db, 'memory_store', {
        type: 'semantic',
        content: 'Redis supports pub/sub messaging for real-time event distribution',
        title: 'Redis Pub/Sub',
        tags: ['redis', 'messaging'],
        importance: 0.8,
      }),
    );
    const storeText = getText(storeResult);
    assert.ok(storeText.includes('Memory stored successfully'), `Store failed: ${storeText}`);
    assert.ok(storeText.includes('Embedding:** generated'), 'Embedding should be generated');
    const id = extractId(storeText);

    // Search — this is the critical path that was hanging
    const searchResult = await timed('memory_search', () =>
      handleMemoryTool(db, 'memory_search', {
        query: 'real-time messaging with Redis',
      }),
    );
    const searchText = getText(searchResult);
    assert.ok(searchText.includes('Found'), `Search returned no results: ${searchText}`);
    assert.ok(searchText.includes(id), 'Search should find the stored memory');
    assert.ok(searchText.includes('hybrid'), 'Should use hybrid search mode');

    // Get
    const getResult = await timed('memory_get', () =>
      handleMemoryTool(db, 'memory_get', { id }),
    );
    const getOutput = getText(getResult);
    assert.ok(getOutput.includes('Redis Pub/Sub'), 'Get should return the title');
    assert.ok(getOutput.includes('pub/sub'), 'Get should return the content');

    // Update
    const updateResult = await timed('memory_update', () =>
      handleMemoryTool(db, 'memory_update', {
        id,
        content: 'Redis supports pub/sub and streams for real-time event distribution and processing',
        importance: 0.9,
      }),
    );
    assert.ok(getText(updateResult).includes('Memory updated'));

    // Search updated content
    const search2 = await timed('memory_search (after update)', () =>
      handleMemoryTool(db, 'memory_search', {
        query: 'Redis streams event processing',
      }),
    );
    assert.ok(getText(search2).includes(id), 'Search should still find updated memory');

    // Delete
    const deleteResult = await timed('memory_delete', () =>
      handleMemoryTool(db, 'memory_delete', { id }),
    );
    assert.ok(getText(deleteResult).includes('deleted'));

    // Verify gone
    const getGone = await timed('memory_get (deleted)', () =>
      handleMemoryTool(db, 'memory_get', { id }),
    );
    assert.ok(getText(getGone).includes('not found'));
  });
});

// ==========================================================
// 3. Search with Backfill (the scenario that hung)
// ==========================================================
describe('Integration: Search with Backfill', { timeout: 120_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    resetBackfillFlag();
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('backfills embeddings for memories inserted without them, then searches', async () => {
    // Simulate hook-inserted memories (no embeddings)
    const memories = [
      { id: 'hook-mem-1', content: 'Session summary: worked on authentication module' },
      { id: 'hook-mem-2', content: 'Session summary: fixed database connection pooling bug' },
      { id: 'hook-mem-3', content: 'Session summary: refactored API error handling' },
      { id: 'hook-mem-4', content: 'Session summary: added rate limiting middleware' },
      { id: 'hook-mem-5', content: 'Session summary: optimized query performance with indexes' },
    ];

    for (const m of memories) {
      db.insertMemory(makeMemoryRow({ ...m, type: 'episodic' }));
    }

    // Verify no embeddings
    const withoutEmbedding = db.getMemoryIdsWithoutEmbedding();
    assert.equal(withoutEmbedding.length, 5, 'All 5 should lack embeddings');

    // Search triggers backfill — this is what was hanging
    const searchResult = await timed('memory_search (triggers backfill of 5 memories)', () =>
      handleMemoryTool(db, 'memory_search', {
        query: 'database connection issues',
      }),
    );
    const searchText = getText(searchResult);
    assert.ok(searchText.includes('Found'), `Backfill+search failed: ${searchText}`);
    assert.ok(
      searchText.includes('database connection pooling'),
      'Should find the relevant memory',
    );

    // Verify embeddings were backfilled
    const stillWithout = db.getMemoryIdsWithoutEmbedding();
    assert.equal(stillWithout.length, 0, 'All memories should now have embeddings');
  });
});

// ==========================================================
// 4. Semantic Ranking with Real Embeddings
// ==========================================================
describe('Integration: Semantic Ranking', { timeout: 120_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('ranks semantically similar results higher than unrelated ones', async () => {
    await timed('store 3 memories', async () => {
      await handleMemoryTool(db, 'memory_store', {
        type: 'semantic',
        content: 'TypeScript generics allow creating reusable type-safe components',
        title: 'TypeScript Generics',
      });
      await handleMemoryTool(db, 'memory_store', {
        type: 'semantic',
        content: 'Chocolate chip cookies need butter, sugar, flour, and chocolate chips',
        title: 'Cookie Recipe',
      });
      await handleMemoryTool(db, 'memory_store', {
        type: 'semantic',
        content: 'Rust uses traits and generic type parameters for polymorphism',
        title: 'Rust Type System',
      });
    });

    const result = await timed('semantic search', () =>
      handleMemoryTool(db, 'memory_search', {
        query: 'generic types and type safety in programming',
      }),
    );
    const text = getText(result);

    const tsIdx = text.indexOf('TypeScript Generics');
    const rustIdx = text.indexOf('Rust Type System');
    const cookieIdx = text.indexOf('Cookie Recipe');

    assert.ok(tsIdx !== -1 || rustIdx !== -1, 'At least one programming memory found');

    if (cookieIdx !== -1 && tsIdx !== -1) {
      assert.ok(tsIdx < cookieIdx, 'Programming results should rank above cookies');
    }
    if (cookieIdx !== -1 && rustIdx !== -1) {
      assert.ok(rustIdx < cookieIdx, 'Programming results should rank above cookies');
    }
  });
});

// ==========================================================
// 5. Deduplication with Real Embeddings
// ==========================================================
describe('Integration: Deduplication', { timeout: 120_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('detects and merges near-duplicate memories', async () => {
    const first = await timed('store original', () =>
      handleMemoryTool(db, 'memory_store', {
        type: 'semantic',
        content: 'Docker containers provide lightweight isolated environments for applications',
      }),
    );
    const firstId = extractId(getText(first));
    assert.equal(db.countMemories(), 1);

    // Exact same content
    const dup = await timed('store exact duplicate', () =>
      handleMemoryTool(db, 'memory_store', {
        type: 'semantic',
        content: 'Docker containers provide lightweight isolated environments for applications',
      }),
    );
    const dupText = getText(dup);
    assert.ok(dupText.includes('Merged'), `Expected merge, got: ${dupText}`);
    assert.ok(dupText.includes(firstId));
    assert.equal(db.countMemories(), 1, 'Should still be 1 memory after merge');
  });
});

// ==========================================================
// 6. Batch Store + Search
// ==========================================================
describe('Integration: Batch Store', { timeout: 120_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('batch stores memories with real embeddings and searches them', async () => {
    const batchResult = await timed('memory_store_batch (4 items)', () =>
      handleMemoryTool(db, 'memory_store_batch', {
        memories: [
          { type: 'semantic', content: 'GraphQL provides a query language for APIs', tags: ['graphql'] },
          { type: 'procedural', content: 'To set up GraphQL: install apollo-server, define schema, implement resolvers', tags: ['graphql'] },
          { type: 'pattern', content: 'Use DataLoader to batch and cache database queries in GraphQL resolvers', title: 'GraphQL N+1 Prevention' },
          { type: 'episodic', content: 'Migrated REST API to GraphQL, reduced payload size by 40%' },
        ],
      }),
    );
    const batchText = getText(batchResult);
    assert.ok(batchText.includes('Batch stored 4 memories'), `Batch failed: ${batchText}`);
    const ids = extractBatchIds(batchText);
    assert.equal(ids.length, 4);

    const search = await timed('search batch-stored memories', () =>
      handleMemoryTool(db, 'memory_search', { query: 'GraphQL API optimization' }),
    );
    const searchText = getText(search);
    assert.ok(searchText.includes('Found'), `Search failed: ${searchText}`);
    assert.ok(searchText.includes('GraphQL'), 'Should find GraphQL memories');
  });
});

// ==========================================================
// 7. Relations & Graph
// ==========================================================
describe('Integration: Relations & Graph', { timeout: 120_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('creates relations between memories and traverses the graph', async () => {
    const m1 = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'OAuth2 authorization code flow for web applications',
      title: 'OAuth2 Flow',
    });
    const id1 = extractId(getText(m1));

    const m2 = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'JWT tokens store claims as base64-encoded JSON with cryptographic signature',
      title: 'JWT Structure',
    });
    const id2 = extractId(getText(m2));

    const m3 = await handleMemoryTool(db, 'memory_store', {
      type: 'pattern',
      content: 'Always validate JWT signature and expiration server-side before trusting claims',
      title: 'JWT Validation Pattern',
    });
    const id3 = extractId(getText(m3));

    // Create relations
    const rel1 = await timed('memory_relate', () =>
      handleMemoryTool(db, 'memory_relate', {
        source_id: id1,
        target_id: id2,
        relation_type: 'depends_on',
        weight: 0.8,
      }),
    );
    assert.ok(getText(rel1).includes('Relation created'));

    const rel2 = await timed('memory_relate', () =>
      handleMemoryTool(db, 'memory_relate', {
        source_id: id3,
        target_id: id2,
        relation_type: 'derived_from',
        weight: 0.9,
      }),
    );
    assert.ok(getText(rel2).includes('Relation created'));

    // Graph traversal
    const graph = await timed('memory_graph (depth 2)', () =>
      handleMemoryTool(db, 'memory_graph', { id: id2, depth: 2 }),
    );
    const graphText = getText(graph);
    assert.ok(graphText.includes('Memory graph'), `Graph failed: ${graphText}`);
    assert.ok(graphText.includes('OAuth2 Flow'));
    assert.ok(graphText.includes('JWT Structure'));
    assert.ok(graphText.includes('JWT Validation Pattern'));
    assert.ok(graphText.includes('depends_on'));
    assert.ok(graphText.includes('derived_from'));

    // Get shows relations
    const getResult = await timed('memory_get (with relations)', () =>
      handleMemoryTool(db, 'memory_get', { id: id2 }),
    );
    assert.ok(getText(getResult).includes('Relations'));
  });
});

// ==========================================================
// 8. All Memory Types
// ==========================================================
describe('Integration: All Memory Types', { timeout: 120_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('stores and lists all 5 memory types with correct defaults', async () => {
    const types = [
      { type: 'episodic' as const, content: 'Fixed CI pipeline this morning' },
      { type: 'semantic' as const, content: 'Kubernetes uses etcd for cluster state storage' },
      { type: 'procedural' as const, content: 'Run kubectl apply -f deployment.yaml to deploy' },
      { type: 'working' as const, content: 'TODO: investigate flaky test in auth module' },
      { type: 'pattern' as const, content: 'Always use readiness probes for K8s deployments' },
    ];

    for (const { type, content } of types) {
      await handleMemoryTool(db, 'memory_store', { type, content });
    }

    assert.equal(db.countMemories(), 5);

    // List all
    const listAll = await timed('memory_list (all)', () =>
      handleMemoryTool(db, 'memory_list', { limit: 10 }),
    );
    assert.ok(getText(listAll).includes('5 memor'));

    // Filter by each type
    for (const { type } of types) {
      const filtered = await handleMemoryTool(db, 'memory_list', { type });
      assert.ok(getText(filtered).includes(`type: ${type}`));
    }

    // Pattern should default to 0.8
    const patternList = await handleMemoryTool(db, 'memory_list', { type: 'pattern' });
    assert.ok(getText(patternList).includes('0.8'));

    // Non-pattern should default to 0.5
    const semanticList = await handleMemoryTool(db, 'memory_list', { type: 'semantic' });
    assert.ok(getText(semanticList).includes('0.5'));
  });
});

// ==========================================================
// 9. Error Handling
// ==========================================================
describe('Integration: Error Handling', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('handles nonexistent IDs gracefully', async () => {
    const ops = [
      { tool: 'memory_get', args: { id: 'NONEXISTENT' } },
      { tool: 'memory_delete', args: { id: 'NONEXISTENT' } },
      { tool: 'memory_update', args: { id: 'NONEXISTENT', content: 'x' } },
      { tool: 'memory_graph', args: { id: 'NONEXISTENT' } },
      { tool: 'memory_relate', args: { source_id: 'A', target_id: 'B', relation_type: 'relates_to' } },
    ];

    for (const { tool, args } of ops) {
      const result = await handleMemoryTool(db, tool, args);
      assert.ok(getText(result).includes('not found'), `${tool} should return not found`);
    }
  });

  it('handles empty search gracefully', async () => {
    const result = await handleMemoryTool(db, 'memory_search', {
      query: 'nothing should match this query xyz123',
    });
    assert.ok(getText(result).includes('No memories found'));
  });

  it('returns error for unknown tool', async () => {
    const result = await handleMemoryTool(db, 'nonexistent_tool', {});
    assert.ok(getText(result).includes('Unknown memory tool'));
  });
});

// ==========================================================
// 10. Cleanup & Maintenance
// ==========================================================
describe('Integration: Cleanup & Maintenance', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('working memory cleanup, episodic cleanup, and importance decay', async () => {
    // Old working memory (inserted directly to control created_at)
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.insertMemory(makeMemoryRow({ id: 'old-working', type: 'working', content: 'stale scratch', created_at: oldDate, updated_at: oldDate }));

    // Fresh working memory via tool
    await handleMemoryTool(db, 'memory_store', { type: 'working', content: 'fresh scratch' });

    assert.equal(db.countMemories(), 2);
    const cleaned = db.cleanupWorkingMemories(24);
    assert.equal(cleaned, 1);
    assert.equal(db.countMemories(), 1);

    // Old episodic memory
    const veryOld = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.insertMemory(makeMemoryRow({ id: 'old-ep', type: 'episodic', content: 'old session', importance: 0.3, created_at: veryOld, updated_at: veryOld }));
    const epCleaned = db.cleanupOldEpisodicMemories(90);
    assert.equal(epCleaned, 1);

    // Importance decay
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    db.insertMemory(makeMemoryRow({ id: 'stale', type: 'semantic', content: 'unused fact', importance: 0.7, created_at: staleDate, updated_at: staleDate }));
    const decayed = db.decayImportance(30, 0.05);
    assert.equal(decayed, 1);
  });
});
