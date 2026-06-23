import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDb, makeMemoryRow, makeEmbedding, cleanup } from './helpers.js';
import { embeddingToBuffer } from '../embeddings.js';
import { handleSessionStart } from '../cli/session-start.js';
import type { MemoryDatabase } from '../database.js';

/**
 * Insert a memory with a pre-computed embedding into the database.
 */
function seedMemory(
  db: MemoryDatabase,
  id: string,
  overrides: Partial<Parameters<typeof makeMemoryRow>[0]>,
  embeddingSeed: number,
): void {
  const embedding = makeEmbedding(embeddingSeed);
  db.insertMemory({
    ...makeMemoryRow({ id, ...overrides }),
    embedding: embeddingToBuffer(embedding),
  });
}

describe('handleSessionStart — multi-query context search', { timeout: 30_000 }, () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('returns valid output with no memories and no git signals', async () => {
    // Use a CWD with all path segments < 3 chars so extractGitSignals produces
    // no CWD-derived signals — that is the actual no-signals path.
    const result = await handleSessionStart(db, { cwd: '/a/bb' });
    assert.ok(result.hookSpecificOutput, 'hookSpecificOutput should be defined');
    assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(result.hookSpecificOutput.additionalContext.includes('# Project Memory Context'));
    assert.ok(result.hookSpecificOutput.additionalContext.includes('session #1'));
    cleanup(db, dir);
  });

  it('increments session count', async () => {
    await handleSessionStart(db, { cwd: '/a/bb' });
    await handleSessionStart(db, { cwd: '/a/bb' });
    const result = await handleSessionStart(db, { cwd: '/a/bb' });
    assert.ok(result.hookSpecificOutput);
    assert.ok(result.hookSpecificOutput.additionalContext.includes('session #3'));
    cleanup(db, dir);
  });

  it('falls back to static sections when no signals exist', async () => {
    seedMemory(
      db,
      'sem-1',
      {
        type: 'semantic',
        title: 'Project Architecture',
        content: 'Uses microservices with event-driven communication',
        importance: 0.8,
      },
      1,
    );
    seedMemory(
      db,
      'proc-1',
      {
        type: 'procedural',
        title: 'Deploy Process',
        content: 'Run npm build then docker push',
        importance: 0.7,
      },
      2,
    );

    // Use a CWD with all segments < 3 chars so no CWD signals are produced
    const result = await handleSessionStart(db, { cwd: '/a/bb' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    // New format: memories appear as compact lines, not under old section headings
    assert.ok(ctx.includes('Project Architecture'));
    cleanup(db, dir);
  });

  it('deduplicates memories across sections', async () => {
    seedMemory(
      db,
      'shared-1',
      {
        type: 'semantic',
        title: 'Shared Memory',
        content: 'This memory is highly important and relevant',
        importance: 0.9,
      },
      1,
    );

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    const occurrences = ctx.split('Shared Memory').length - 1;
    assert.equal(occurrences, 1, `Memory must appear exactly once, got ${occurrences}`);
    cleanup(db, dir);
  });

  it('surfaces semantic memories in compact format', async () => {
    seedMemory(
      db,
      'sem-1',
      {
        type: 'semantic',
        content: 'A semantic fact about the project',
        importance: 0.8,
      },
      1,
    );
    seedMemory(
      db,
      'ep-1',
      {
        type: 'episodic',
        content: 'Something that happened recently',
        importance: 0.8,
      },
      2,
    );

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    // Compact format must tag the memory type with [semantic] — verifying the
    // format header specifically, not just that some memory content appeared.
    assert.ok(ctx.includes('[semantic]'), 'semantic memory must be labelled with [semantic] in compact format');
    cleanup(db, dir);
  });

  it('includes recent episodic memories in output', async () => {
    seedMemory(
      db,
      'ep-1',
      {
        type: 'episodic',
        content: 'Worked on authentication module',
        context: 'auth project',
      },
      1,
    );

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    assert.ok(ctx.includes('authentication module'));
    cleanup(db, dir);
  });

  it('includes pattern memories in output', async () => {
    seedMemory(
      db,
      'pat-1',
      {
        type: 'pattern',
        title: 'Error Handling Pattern',
        content: 'Always use Result types instead of exceptions',
        importance: 0.8,
      },
      1,
    );

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    assert.ok(ctx.includes('Error Handling Pattern'));
    cleanup(db, dir);
  });

  it('runs auto-consolidation when accumulated weight exceeds threshold', async () => {
    db.setSessionMeta('session_count', '5');
    db.setSessionMeta('last_consolidation', '3');
    db.setSessionMeta('consolidation_weight', '11.0');

    // Add some memories so consolidation has something to process
    seedMemory(db, 'sem-1', { type: 'semantic', content: 'fact one', importance: 0.5 }, 1);
    seedMemory(db, 'ep-1', { type: 'episodic', content: 'event one', importance: 0.5 }, 2);

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    assert.ok(!ctx.includes('Consolidation Due'), 'Should not show old consolidation prompt');
    assert.ok(ctx.includes('session #6'));
    assert.equal(db.getSessionMeta('last_consolidation'), '6');
    assert.equal(db.getSessionMeta('consolidation_weight'), '0');
    cleanup(db, dir);
  });

  it('auto-consolidation deletes stale memories', async () => {
    db.setSessionMeta('session_count', '5');
    db.setSessionMeta('last_consolidation', '3');
    db.setSessionMeta('consolidation_weight', '15.0');

    const oldDate = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString();
    seedMemory(
      db,
      'stale-1',
      {
        type: 'semantic',
        content: 'stale memory content',
        importance: 0.05,
        access_count: 0,
        created_at: oldDate,
        updated_at: oldDate,
      },
      1,
    );

    const beforeCount = db.countMemories();
    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;
    const afterCount = db.countMemories();

    assert.ok(afterCount < beforeCount, 'Stale memory should be deleted');
    assert.ok(ctx.includes('stale deleted'), 'Should report stale deletions');
    cleanup(db, dir);
  });

  it('does not trigger consolidation when weight is below threshold', async () => {
    db.setSessionMeta('session_count', '3');
    db.setSessionMeta('last_consolidation', '0');
    db.setSessionMeta('consolidation_weight', '2.5');

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    assert.ok(!ctx.includes('Consolidation Due'));
    cleanup(db, dir);
  });

  it('cleans up working memories', async () => {
    seedMemory(
      db,
      'working-1',
      {
        type: 'working',
        content: 'Temporary scratchpad data',
      },
      1,
    );

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    assert.ok(ctx.includes('1 working cleared'));
    cleanup(db, dir);
  });

  it('compaction source preserves session state and re-injects pattern rules', async () => {
    db.setSessionMeta('session_count', '7');
    seedMemory(db, 'working-1', { type: 'working', content: 'in-flight scratchpad' }, 1);
    seedMemory(
      db,
      'pat-1',
      { type: 'pattern', title: 'Error Handling Pattern', content: 'Always use Result types', importance: 0.8 },
      2,
    );

    const result = await handleSessionStart(db, { cwd: '/a/bb', source: 'compact' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    // (a) working memory survives a compaction continuation
    assert.ok(db.getMemoryByIdRaw('working-1'), 'working memory must survive compaction');

    // (b) session_count is not bumped — this is a continuation, not a new session
    assert.equal(db.getSessionMeta('session_count'), '7');
    assert.ok(ctx.includes('session #7'));

    // (c) pattern importance is unchanged (no decay on compaction)
    assert.equal(db.getMemoryByIdRaw('pat-1')?.importance, 0.8);

    // (d) the block carries the compaction header and at least one directive pattern line
    assert.ok(ctx.includes('Context was compacted — these prior rules still apply:'));
    assert.ok(/^- \[pattern.*\] Apply — /m.test(ctx), 'expected at least one "Apply —" pattern line');

    cleanup(db, dir);
  });

  it('absent source behaves like a normal startup (regression)', async () => {
    db.setSessionMeta('session_count', '7');
    seedMemory(db, 'working-1', { type: 'working', content: 'in-flight scratchpad' }, 1);

    const result = await handleSessionStart(db, { cwd: '/a/bb' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    // Normal startup: working wiped, session_count bumped, no compaction header.
    assert.equal(db.getMemoryByIdRaw('working-1'), null, 'working memory must be cleared on normal startup');
    assert.equal(db.getSessionMeta('session_count'), '8');
    assert.ok(ctx.includes('session #8'));
    assert.ok(!ctx.includes('Context was compacted'));

    cleanup(db, dir);
  });

  it('session-start output is compact and has no behavioural reminder', async () => {
    const { db: testDb, dir: testDir } = makeTempDb();
    try {
      for (let i = 0; i < 30; i++) {
        testDb.insertMemory(makeMemoryRow({ id: `m${i}`, type: 'semantic' }));
      }
      const result = await handleSessionStart(testDb, { cwd: process.cwd() });
      const ctx = result.hookSpecificOutput?.additionalContext ?? '';
      assert.doesNotMatch(ctx, /CRITICAL/);
      assert.doesNotMatch(ctx, /MUST call `memory_search`/);
      assert.doesNotMatch(ctx, /behavioural reminder/i);
      const itemCount = (ctx.match(/^- \[/gm) ?? []).length;
      assert.ok(itemCount <= 10, `expected <= 10 items, got ${itemCount}`);
    } finally {
      testDb.close();
      const { rmSync } = await import('node:fs');
      rmSync(testDir, { recursive: true });
    }
  });
});
