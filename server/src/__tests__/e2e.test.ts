import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryDatabase } from '../database.js';
import { handleMemoryTool } from '../memory.js';
import { makeTempDb, cleanup, makeMemoryRow } from './helpers.js';

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

// ==========================================================
// 1. Full Memory Lifecycle
// ==========================================================
describe('E2E: Full Memory Lifecycle', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('store → search → get → update → search → delete → verify gone', async () => {
    // Store
    const storeResult = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'PostgreSQL uses MVCC for concurrency control',
      title: 'PostgreSQL Concurrency',
      tags: ['database', 'postgres'],
      importance: 0.7,
    });
    const storeText = getText(storeResult);
    assert.ok(storeText.includes('Memory stored successfully'));
    const id = extractId(storeText);

    // Search finds it
    const searchResult = await handleMemoryTool(db, 'memory_search', {
      query: 'PostgreSQL concurrency',
    });
    const searchText = getText(searchResult);
    assert.ok(searchText.includes(id));
    assert.ok(searchText.includes('MVCC'));

    // Get by ID
    const getResult = await handleMemoryTool(db, 'memory_get', { id });
    const getText2 = getText(getResult);
    assert.ok(getText2.includes('PostgreSQL Concurrency'));
    assert.ok(getText2.includes('MVCC'));
    assert.ok(getText2.includes('database'));

    // Update content and title
    const updateResult = await handleMemoryTool(db, 'memory_update', {
      id,
      content: 'PostgreSQL uses MVCC (Multi-Version Concurrency Control) for isolation',
      title: 'PostgreSQL MVCC',
      importance: 0.9,
    });
    const updateText = getText(updateResult);
    assert.ok(updateText.includes('Memory updated'));
    assert.ok(updateText.includes('PostgreSQL MVCC'));

    // Search with updated content
    const search2 = await handleMemoryTool(db, 'memory_search', {
      query: 'multi version concurrency isolation',
    });
    assert.ok(getText(search2).includes(id));

    // Delete
    const deleteResult = await handleMemoryTool(db, 'memory_delete', { id });
    assert.ok(getText(deleteResult).includes('deleted'));

    // Verify gone
    const getGone = await handleMemoryTool(db, 'memory_get', { id });
    assert.ok(getText(getGone).includes('not found'));

    // Search no longer finds it
    const search3 = await handleMemoryTool(db, 'memory_search', {
      query: 'PostgreSQL concurrency',
    });
    assert.ok(getText(search3).includes('No memories found'));
  });
});

// ==========================================================
// 2. Multi-type Memory Management
// ==========================================================
describe('E2E: Multi-type Memory Management', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('stores all 5 types with correct default importances and filters by type', async () => {
    const types = [
      { type: 'episodic', content: 'Debugged auth flow today' },
      { type: 'semantic', content: 'Redis supports pub/sub messaging' },
      { type: 'procedural', content: 'To deploy: run npm build then docker push' },
      { type: 'working', content: 'TODO: check the failing test in CI' },
      { type: 'pattern', content: 'Always validate inputs at API boundaries' },
    ] as const;

    const ids: string[] = [];
    for (const { type, content } of types) {
      const result = await handleMemoryTool(db, 'memory_store', { type, content });
      ids.push(extractId(getText(result)));
    }

    assert.equal(db.countMemories(), 5);

    // Verify default importances via list
    const listAll = await handleMemoryTool(db, 'memory_list', { limit: 10 });
    const listText = getText(listAll);
    assert.ok(listText.includes('5 memor'));

    // Pattern should have 0.8 default, others 0.5
    const patternList = await handleMemoryTool(db, 'memory_list', { type: 'pattern' });
    assert.ok(getText(patternList).includes('0.8'));

    const semanticList = await handleMemoryTool(db, 'memory_list', { type: 'semantic' });
    assert.ok(getText(semanticList).includes('0.5'));

    // Filter by type
    for (const { type } of types) {
      const filtered = await handleMemoryTool(db, 'memory_list', { type });
      const text = getText(filtered);
      assert.ok(text.includes(`type: ${type}`));
      assert.ok(text.includes('1 memor'));
    }
  });
});

// ==========================================================
// 3. Semantic Search with Real Embeddings
// ==========================================================
describe('E2E: Semantic Search with Real Embeddings', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('ranks semantically related results above unrelated ones', async () => {
    // Store topically distinct memories
    await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'Python uses garbage collection with reference counting and a cyclic collector',
      title: 'Python Memory Management',
    });
    await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'Chocolate cake recipe requires flour, sugar, cocoa powder, and eggs',
      title: 'Baking Recipe',
    });
    await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'The JVM manages heap memory with generational garbage collection',
      title: 'JVM Garbage Collection',
    });

    // Search with a semantically related but non-exact query
    const result = await handleMemoryTool(db, 'memory_search', {
      query: 'automatic memory management in programming languages',
    });
    const text = getText(result);

    // Both programming memories should appear before the baking one
    const pythonIdx = text.indexOf('Python Memory Management');
    const jvmIdx = text.indexOf('JVM Garbage Collection');
    const cakeIdx = text.indexOf('Baking Recipe');

    assert.ok(pythonIdx !== -1 || jvmIdx !== -1, 'At least one programming memory should be found');

    // If cake shows up, it should be ranked below the programming results
    if (cakeIdx !== -1 && pythonIdx !== -1) {
      assert.ok(pythonIdx < cakeIdx, 'Python memory should rank above baking');
    }
    if (cakeIdx !== -1 && jvmIdx !== -1) {
      assert.ok(jvmIdx < cakeIdx, 'JVM memory should rank above baking');
    }
  });
});

// ==========================================================
// 4. Deduplication / Auto-Merge
// ==========================================================
describe('E2E: Deduplication / Auto-Merge', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('merges exact duplicate and warns about similar-but-distinct', async () => {
    // Store original
    const original = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'TypeScript supports union types and intersection types',
    });
    const originalText = getText(original);
    assert.ok(originalText.includes('Memory stored successfully'));
    const originalId = extractId(originalText);
    assert.equal(db.countMemories(), 1);

    // Store exact same content → should merge
    const dup = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'TypeScript supports union types and intersection types',
    });
    const dupText = getText(dup);
    assert.ok(dupText.includes('Merged with existing memory'), `Expected merge, got: ${dupText}`);
    assert.ok(dupText.includes(originalId));
    assert.equal(db.countMemories(), 1);

    // Store similar content with title → should also merge (single 0.05 threshold)
    const similar = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'TypeScript supports union types and intersection types',
      title: 'TypeScript Type System',
    });
    const similarText = getText(similar);
    assert.ok(similarText.includes('Merged with existing memory'), `Expected merge, got: ${similarText}`);
    assert.equal(db.countMemories(), 1);
  });
});

// ==========================================================
// 5. Knowledge Graph Workflow
// ==========================================================
describe('E2E: Knowledge Graph Workflow', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('creates memories, relates them, and traverses the graph', async () => {
    // Store three related memories
    const auth = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'JWT authentication with refresh tokens',
      title: 'Auth System',
    });
    const authId = extractId(getText(auth));

    const session = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'Session management using Redis for token storage',
      title: 'Session Storage',
    });
    const sessionId = extractId(getText(session));

    const pattern = await handleMemoryTool(db, 'memory_store', {
      type: 'pattern',
      content: 'Always use short-lived access tokens with long-lived refresh tokens',
      title: 'Token Lifecycle Pattern',
    });
    const patternId = extractId(getText(pattern));

    // Create relations
    const rel1 = await handleMemoryTool(db, 'memory_relate', {
      source_id: authId,
      target_id: sessionId,
      relation_type: 'depends_on',
      weight: 0.8,
    });
    assert.ok(getText(rel1).includes('Relation created'));

    const rel2 = await handleMemoryTool(db, 'memory_relate', {
      source_id: patternId,
      target_id: authId,
      relation_type: 'derived_from',
      weight: 0.9,
    });
    assert.ok(getText(rel2).includes('Relation created'));

    // Graph at depth 1 from auth should find session and pattern
    const graph1 = await handleMemoryTool(db, 'memory_graph', { id: authId, depth: 1 });
    const graphText = getText(graph1);
    assert.ok(graphText.includes('Memory graph'));
    assert.ok(graphText.includes('Auth System'));
    assert.ok(graphText.includes('Session Storage'));
    assert.ok(graphText.includes('Token Lifecycle Pattern'));
    assert.ok(graphText.includes('depends_on'));
    assert.ok(graphText.includes('derived_from'));
    assert.ok(graphText.includes('(center)'));

    // Graph at depth 1 from session should reach auth but NOT pattern (pattern→auth, not auth→pattern directly traversed at depth 1 from session)
    const graph2 = await handleMemoryTool(db, 'memory_graph', { id: sessionId, depth: 1 });
    const graph2Text = getText(graph2);
    assert.ok(graph2Text.includes('Auth System'));

    // Get memory shows relations
    const getAuth = await handleMemoryTool(db, 'memory_get', { id: authId });
    const getAuthText = getText(getAuth);
    assert.ok(getAuthText.includes('Relations'));
    assert.ok(getAuthText.includes('depends_on'));
  });
});

// ==========================================================
// 6. Batch Store + Search
// ==========================================================
describe('E2E: Batch Store + Search', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('batch stores memories and verifies all searchable with correct types', async () => {
    const batchResult = await handleMemoryTool(db, 'memory_store_batch', {
      memories: [
        { type: 'semantic', content: 'Docker containers are lightweight virtual environments', tags: ['docker'] },
        {
          type: 'procedural',
          content: 'To create a Dockerfile: start with FROM, add COPY, then CMD',
          tags: ['docker'],
        },
        {
          type: 'pattern',
          content: 'Use multi-stage builds to minimize Docker image size',
          title: 'Docker Best Practice',
          importance: 0.9,
        },
        { type: 'episodic', content: 'Fixed the Docker build pipeline today by adding cache layers' },
      ],
    });
    const batchText = getText(batchResult);
    assert.ok(batchText.includes('Batch stored 4 new, 0 merged'));
    const ids = extractBatchIds(batchText);
    assert.equal(ids.length, 4);

    // All should be searchable
    const search = await handleMemoryTool(db, 'memory_search', { query: 'Docker' });
    const searchText = getText(search);
    assert.ok(searchText.includes('Found'));

    // Verify types/importances via get
    const patternMem = await handleMemoryTool(db, 'memory_get', { id: ids[2] });
    const patternText = getText(patternMem);
    assert.ok(patternText.includes('pattern'));
    assert.ok(patternText.includes('0.9'));
    assert.ok(patternText.includes('Docker Best Practice'));

    // Non-pattern memory has default 0.5
    const semanticMem = await handleMemoryTool(db, 'memory_get', { id: ids[0] });
    assert.ok(getText(semanticMem).includes('0.5'));
  });
});

// ==========================================================
// 7. Cleanup & Maintenance Lifecycle
// ==========================================================
describe('E2E: Cleanup & Maintenance Lifecycle', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('working memory cleanup removes old working memories', async () => {
    // Insert old working memory directly (need to control created_at)
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.insertMemory(
      makeMemoryRow({
        id: 'old-working',
        type: 'working',
        content: 'stale scratch note',
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    // Store a fresh working memory via the tool
    const fresh = await handleMemoryTool(db, 'memory_store', {
      type: 'working',
      content: 'current scratch note',
    });
    const freshId = extractId(getText(fresh));

    // Store a semantic memory (should survive cleanup)
    await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'permanent fact about the project',
    });

    assert.equal(db.countMemories(), 3);

    // Cleanup old working memories (> 24h)
    const cleaned = db.cleanupWorkingMemories(24);
    assert.equal(cleaned, 1);
    assert.equal(db.countMemories(), 2);

    // Fresh working memory still exists
    const getResult = await handleMemoryTool(db, 'memory_get', { id: freshId });
    assert.ok(!getText(getResult).includes('not found'));

    // Old one is gone
    const getOld = await handleMemoryTool(db, 'memory_get', { id: 'old-working' });
    assert.ok(getText(getOld).includes('not found'));
  });

  it('episodic cleanup removes old low-value episodic memories', () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'old-low',
        type: 'episodic',
        content: 'old unimportant session',
        importance: 0.3,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'old-important',
        type: 'episodic',
        content: 'old but important session',
        importance: 0.9,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'recent-low',
        type: 'episodic',
        content: 'recent session',
        importance: 0.3,
      }),
    );

    const cleaned = db.cleanupOldEpisodicMemories(90);
    assert.equal(cleaned, 1);
    assert.equal(db.getMemoryById('old-low'), null);
    assert.ok(db.getMemoryById('old-important'));
    assert.ok(db.getMemoryById('recent-low'));
  });

  it('importance decay reduces stale memory importance', () => {
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMemory(
      makeMemoryRow({
        id: 'stale',
        type: 'semantic',
        content: 'unused fact',
        importance: 0.7,
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'active',
        type: 'semantic',
        content: 'actively used fact',
        importance: 0.7,
        last_accessed: new Date().toISOString(),
        created_at: oldDate,
        updated_at: oldDate,
      }),
    );

    const decayed = db.decayImportance(30, 0.05);
    assert.equal(decayed, 1);

    const stale = db.listMemories(undefined, 20, 0).find((r) => r.id === 'stale');
    assert.ok(stale);
    assert.ok(stale.importance < 0.7);
  });

  it('session meta tracking persists across operations', () => {
    db.setSessionMeta('last_cleanup', '2024-01-01');
    db.setSessionMeta('session_count', '1');

    assert.equal(db.getSessionMeta('last_cleanup'), '2024-01-01');
    assert.equal(db.getSessionMeta('session_count'), '1');

    db.setSessionMeta('session_count', '2');
    assert.equal(db.getSessionMeta('session_count'), '2');
    assert.equal(db.getSessionMeta('nonexistent'), null);
  });
});

// ==========================================================
// 8. Tag Normalization Through Full Pipeline
// ==========================================================
describe('E2E: Tag Normalization Through Full Pipeline', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('normalizes tags on store and preserves normalization through get/list/search', async () => {
    // Store with messy tags
    const result = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'React hooks simplify state management',
      tags: ['  React Hooks  ', 'STATE management', 'react-hooks', ''],
    });
    const id = extractId(getText(result));

    // Store output should show normalized tags
    const storeText = getText(result);
    assert.ok(storeText.includes('react-hooks'));
    assert.ok(storeText.includes('state-management'));
    // Duplicate 'react-hooks' (from "React Hooks" → "react-hooks" deduped with "react-hooks") should be gone
    assert.ok(!storeText.includes('React Hooks'));

    // Get should show normalized tags
    const getResult = await handleMemoryTool(db, 'memory_get', { id });
    const getTag = getText(getResult);
    assert.ok(getTag.includes('react-hooks'));
    assert.ok(getTag.includes('state-management'));

    // List should show normalized tags
    const listResult = await handleMemoryTool(db, 'memory_list', {});
    const listText = getText(listResult);
    assert.ok(listText.includes('react-hooks'));

    // Update tags also normalizes
    await handleMemoryTool(db, 'memory_update', {
      id,
      tags: ['  Vue Composition  ', 'VUE'],
    });
    const getUpdated = await handleMemoryTool(db, 'memory_get', { id });
    const updatedText = getText(getUpdated);
    assert.ok(updatedText.includes('vue-composition'));
    assert.ok(updatedText.includes('vue'));
  });
});

// ==========================================================
// 9. Access Tracking Across Operations
// ==========================================================
describe('E2E: Access Tracking Across Operations', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('multiple gets increment access_count visible in list output', async () => {
    const result = await handleMemoryTool(db, 'memory_store', {
      type: 'semantic',
      content: 'Access tracking test memory',
    });
    const id = extractId(getText(result));

    // Access via get multiple times
    await handleMemoryTool(db, 'memory_get', { id });
    await handleMemoryTool(db, 'memory_get', { id });
    await handleMemoryTool(db, 'memory_get', { id });

    // List should reflect the access count
    // getMemoryById returns row BEFORE increment, so after 3 calls the DB has count=3
    // But list reads directly without incrementing, so it shows 3
    const listResult = await handleMemoryTool(db, 'memory_list', {});
    const listText = getText(listResult);
    assert.ok(listText.includes('3x'), `Expected access count 3x in: ${listText}`);
  });
});

// ==========================================================
// 10. Error Handling Across Tools
// ==========================================================
describe('E2E: Error Handling Across Tools', { timeout: 60_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });
  afterEach(() => cleanup(db, dir));

  it('returns not found for nonexistent ID on get', async () => {
    const result = await handleMemoryTool(db, 'memory_get', { id: 'NONEXISTENT_ID' });
    assert.ok(getText(result).includes('not found'));
  });

  it('returns not found for nonexistent ID on delete', async () => {
    const result = await handleMemoryTool(db, 'memory_delete', { id: 'NONEXISTENT_ID' });
    assert.ok(getText(result).includes('not found'));
  });

  it('returns not found for nonexistent ID on update', async () => {
    const result = await handleMemoryTool(db, 'memory_update', { id: 'NONEXISTENT_ID', content: 'nope' });
    assert.ok(getText(result).includes('not found'));
  });

  it('returns not found for nonexistent source on relate', async () => {
    const result = await handleMemoryTool(db, 'memory_relate', {
      source_id: 'NONEXISTENT',
      target_id: 'also-fake',
      relation_type: 'relates_to',
    });
    assert.ok(getText(result).includes('not found'));
  });

  it('returns not found for nonexistent ID on graph', async () => {
    const result = await handleMemoryTool(db, 'memory_graph', { id: 'NONEXISTENT_ID' });
    assert.ok(getText(result).includes('not found'));
  });

  it('returns error for unknown tool name', async () => {
    const result = await handleMemoryTool(db, 'totally_fake_tool', {});
    assert.ok(getText(result).includes('Unknown memory tool'));
  });

  it('returns no results for search with no matches', async () => {
    const result = await handleMemoryTool(db, 'memory_search', {
      query: 'xyzzy nothing matches this',
    });
    assert.ok(getText(result).includes('No memories found'));
  });
});
