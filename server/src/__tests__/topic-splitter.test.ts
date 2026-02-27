import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryDatabase } from '../database.js';
import { splitByTopics, insertSplitSections } from '../topic-splitter.js';
import { makeTempDb, cleanup, makeEmbedding } from './helpers.js';

// ==========================================================
// splitByTopics — gating
// ==========================================================
describe('splitByTopics — gating', () => {
  it('returns shouldSplit: false for short content', () => {
    const result = splitByTopics('Short content');
    assert.equal(result.shouldSplit, false);
  });

  it('returns shouldSplit: false for content under 500 chars with headers', () => {
    const content = '## Section 1\nSome text\n## Section 2\nMore text';
    assert.ok(content.length < 500);
    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, false);
  });

  it('returns shouldSplit: false for content with only one section', () => {
    const content = '## Only Section\n' + 'a'.repeat(500);
    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, false);
  });
});

// ==========================================================
// splitByTopics — H2 splitting
// ==========================================================
describe('splitByTopics — H2 headers', () => {
  it('splits content by H2 headers', () => {
    const content =
      '## Database Schema\n' +
      'The database uses PostgreSQL with the following tables...\n' +
      'a'.repeat(100) +
      '\n\n## Search Algorithm\n' +
      'Hybrid search combines FTS and vector similarity...\n' +
      'b'.repeat(100) +
      '\n\n## Session Lifecycle\n' +
      'Sessions are managed through hooks...\n' +
      'c'.repeat(100);

    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      assert.equal(result.sections.length, 3);
      assert.equal(result.sections[0].title, 'Database Schema');
      assert.equal(result.sections[1].title, 'Search Algorithm');
      assert.equal(result.sections[2].title, 'Session Lifecycle');
    }
  });

  it('prefixes section titles with original title when provided', () => {
    const content =
      '## Schema\n' +
      'x'.repeat(250) +
      '\n\n## Search\n' +
      'y'.repeat(250);

    const result = splitByTopics(content, 'Architecture Guide');
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      assert.equal(result.sections[0].title, 'Architecture Guide: Schema');
      assert.equal(result.sections[1].title, 'Architecture Guide: Search');
    }
  });
});

// ==========================================================
// splitByTopics — H3 splitting
// ==========================================================
describe('splitByTopics — H3 headers', () => {
  it('splits by H3 when no H2 headers present', () => {
    const content =
      '### Insert Operations\n' +
      'Insert memory into the database with FTS indexing...\n' +
      'a'.repeat(100) +
      '\n\n### Search Operations\n' +
      'Search uses hybrid FTS + vector approach...\n' +
      'b'.repeat(100) +
      '\n\n### Delete Operations\n' +
      'Delete cascades to FTS and vec tables...\n' +
      'c'.repeat(100);

    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      assert.equal(result.sections.length, 3);
      assert.equal(result.sections[0].title, 'Insert Operations');
    }
  });
});

// ==========================================================
// splitByTopics — bold-colon splitting
// ==========================================================
describe('splitByTopics — bold-colon headers', () => {
  it('splits by **Header:** pattern', () => {
    const content =
      '**Database Layer:**\n' +
      'SQLite with WAL mode and foreign keys enabled.\n' +
      'a'.repeat(100) +
      '\n\n**Embedding Engine:**\n' +
      'Uses all-MiniLM-L6-v2 for 384-dim vectors.\n' +
      'b'.repeat(100) +
      '\n\n**Search Pipeline:**\n' +
      'Combines FTS5 text matching with cosine similarity.\n' +
      'c'.repeat(100);

    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      assert.equal(result.sections.length, 3);
      assert.equal(result.sections[0].title, 'Database Layer');
    }
  });

  it('splits by **Header** (without colon) when followed by newline', () => {
    const content =
      '**First Topic**\n' +
      'Details about the first topic with enough content.\n' +
      'a'.repeat(200) +
      '\n\n**Second Topic**\n' +
      'Details about the second topic with enough content.\n' +
      'b'.repeat(200);

    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      assert.equal(result.sections.length, 2);
    }
  });

  it('does not split on inline bold text', () => {
    // Bold text used inline (e.g., "**term** in a sentence") should not be treated as a header
    const content =
      'The **first concept** is important in this context.\n' +
      'a'.repeat(200) +
      '\nThe **second concept** also matters here.\n' +
      'b'.repeat(200);

    const result = splitByTopics(content);
    // Should NOT split on inline bold — these are not headers
    assert.equal(result.shouldSplit, false);
  });
});

// ==========================================================
// splitByTopics — numbered bold items
// ==========================================================
describe('splitByTopics — numbered bold items', () => {
  it('splits by numbered bold pattern', () => {
    const content =
      '1. **Memory Store**\nHandles single memory insertion with dedup.\n' +
      'a'.repeat(150) +
      '\n\n2. **Memory Search**\nHybrid FTS + vector search pipeline.\n' +
      'b'.repeat(150) +
      '\n\n3. **Memory Batch**\nBulk insert with within-batch dedup.\n' +
      'c'.repeat(150);

    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      assert.equal(result.sections.length, 3);
      assert.equal(result.sections[0].title, 'Memory Store');
    }
  });
});

// ==========================================================
// splitByTopics — preamble handling
// ==========================================================
describe('splitByTopics — preamble', () => {
  it('includes preamble as separate section when substantial', () => {
    const preamble = 'This document describes the complete architecture.\n' + 'x'.repeat(120);
    const content =
      preamble +
      '\n\n## First Section\n' +
      'a'.repeat(200) +
      '\n\n## Second Section\n' +
      'b'.repeat(200);

    const result = splitByTopics(content, 'Architecture');
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      assert.equal(result.sections.length, 3);
      assert.equal(result.sections[0].title, 'Architecture');
      assert.ok(result.sections[0].body.includes('complete architecture'));
    }
  });

  it('discards short preamble', () => {
    const content =
      'Intro.\n\n## First Section\n' +
      'a'.repeat(250) +
      '\n\n## Second Section\n' +
      'b'.repeat(250);

    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      assert.equal(result.sections.length, 2);
      assert.equal(result.sections[0].title, 'First Section');
    }
  });
});

// ==========================================================
// splitByTopics — tiny section filtering
// ==========================================================
describe('splitByTopics — section filtering', () => {
  it('filters out sections with body < 50 chars', () => {
    const content =
      '## Big Section\n' +
      'a'.repeat(250) +
      '\n\n## Tiny\nAbc\n\n## Another Big Section\n' +
      'b'.repeat(250);

    const result = splitByTopics(content);
    assert.equal(result.shouldSplit, true);
    if (result.shouldSplit) {
      const titles = result.sections.map((s) => s.title);
      assert.ok(!titles.includes('Tiny'));
      assert.equal(result.sections.length, 2);
    }
  });
});

// ==========================================================
// insertSplitSections
// ==========================================================
describe('insertSplitSections', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('inserts sections and creates sibling relations', async () => {
    const sections = [
      { title: 'Part A', body: 'Content about part A' },
      { title: 'Part B', body: 'Content about part B' },
      { title: 'Part C', body: 'Content about part C' },
    ];

    const result = await insertSplitSections(db, sections, {
      type: 'semantic',
      tags: ['architecture'],
    });

    assert.equal(result.insertedIds.length, 3);
    assert.equal(result.newIds.length, 3);
    assert.equal(result.mergedIds.length, 0);
    assert.equal(result.mergedCount, 0);
    // 3 sections with full mesh = 3 relations (A-B, A-C, B-C)
    assert.equal(result.relationsCreated, 3);
    assert.equal(db.countMemories(), 3);

    // Verify titles stored correctly
    for (let i = 0; i < 3; i++) {
      const mem = db.getMemoryByIdRaw(result.insertedIds[i]);
      assert.ok(mem);
      assert.equal(mem!.title, sections[i].title);
      assert.equal(mem!.type, 'semantic');
    }

    cleanup(db, dir);
  });

  it('uses chain topology for >5 sections', async () => {
    const sections = Array.from({ length: 7 }, (_, i) => ({
      title: `Section ${i}`,
      body: `Content for section ${i}`,
    }));

    const result = await insertSplitSections(db, sections, { type: 'semantic' });

    assert.equal(result.insertedIds.length, 7);
    assert.equal(result.newIds.length, 7);
    // Chain: 6 relations for 7 nodes
    assert.equal(result.relationsCreated, 6);

    cleanup(db, dir);
  });

  it('merges with existing similar memory', async () => {
    // Pre-insert a memory with an embedding
    const { makeMemoryRow } = await import('./helpers.js');
    db.insertMemory(makeMemoryRow({ id: 'existing', content: 'Content about part A', title: 'Part A' }));
    db.updateMemoryEmbedding('existing', makeEmbedding(1));

    // Insert sections — first one should merge if embeddings happen to match
    const sections = [
      { title: 'Part A', body: 'Content about part A' },
      { title: 'Part B', body: 'Content about part B that is different' },
    ];

    const result = await insertSplitSections(db, sections, { type: 'semantic' });

    assert.equal(result.insertedIds.length, 2);
    // Total memories: existing (possibly merged) + any new inserts
    assert.ok(db.countMemories() >= 2);

    cleanup(db, dir);
  });

  it('applies correct importance for pattern type', async () => {
    const sections = [
      { title: 'Pattern A', body: 'Recurring behavior observed in multiple sessions' },
      { title: 'Pattern B', body: 'Another recurring pattern detected by clustering' },
    ];

    const result = await insertSplitSections(db, sections, { type: 'pattern' });

    for (const id of result.newIds) {
      const mem = db.getMemoryByIdRaw(id);
      if (mem && mem.type === 'pattern') {
        assert.equal(mem.importance, 0.8);
      }
    }

    cleanup(db, dir);
  });

  it('passes tags and metadata through', async () => {
    const sections = [
      { title: 'Section', body: 'Some content here' },
      { title: 'Other', body: 'Other content here' },
    ];

    const result = await insertSplitSections(db, sections, {
      type: 'semantic',
      context: 'test context',
      source: 'test.ts',
      tags: ['test-tag'],
      importance: 0.9,
    });

    for (const id of result.newIds) {
      const mem = db.getMemoryByIdRaw(id);
      if (mem) {
        assert.equal(mem.context, 'test context');
        assert.equal(mem.source, 'test.ts');
        assert.ok(mem.tags.includes('test-tag'));
        assert.ok(mem.tags.includes('split-origin'));
        assert.equal(mem.importance, 0.9);
      }
    }

    cleanup(db, dir);
  });

  it('adds split-origin tag to inserted sections', async () => {
    const sections = [
      { title: 'Part A', body: 'Content about part A' },
      { title: 'Part B', body: 'Content about part B' },
    ];

    const result = await insertSplitSections(db, sections, {
      type: 'semantic',
      tags: ['existing-tag'],
    });

    for (const id of result.newIds) {
      const mem = db.getMemoryByIdRaw(id);
      assert.ok(mem);
      const tags = JSON.parse(mem!.tags);
      assert.ok(tags.includes('split-origin'), 'should have split-origin tag');
      assert.ok(tags.includes('existing-tag'), 'should preserve existing tags');
    }

    cleanup(db, dir);
  });

  it('only uses type-filtered similarity for dedup', async () => {
    const { makeMemoryRow } = await import('./helpers.js');
    // Insert an episodic memory with an embedding
    db.insertMemory(makeMemoryRow({ id: 'episodic-mem', type: 'episodic', content: 'Same content' }));
    db.updateMemoryEmbedding('episodic-mem', makeEmbedding(42));

    // Insert semantic sections — should NOT merge with episodic even if similar
    const sections = [
      { title: 'Part A', body: 'Same content' },
      { title: 'Part B', body: 'Different content here' },
    ];

    const result = await insertSplitSections(db, sections, { type: 'semantic' });

    // The episodic memory should still exist (not merged)
    const episodic = db.getMemoryByIdRaw('episodic-mem');
    assert.ok(episodic, 'episodic memory should not be affected by semantic split');
    // All IDs should be new (no merges with the episodic one)
    assert.equal(result.newIds.length, 2);

    cleanup(db, dir);
  });
});
