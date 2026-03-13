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
    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput, 'hookSpecificOutput should be defined');
    assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(result.hookSpecificOutput.additionalContext.includes('# Project Memory Context'));
    assert.ok(result.hookSpecificOutput.additionalContext.includes('session #1'));
    cleanup(db, dir);
  });

  it('increments session count', async () => {
    await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
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

    assert.ok(ctx.includes('Key Knowledge'));
    assert.ok(ctx.includes('Project Architecture'));
    assert.ok(ctx.includes('Procedures'));
    assert.ok(ctx.includes('Deploy Process'));
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
    assert.ok(occurrences <= 1, `Memory appeared ${occurrences} times, expected at most 1`);
    cleanup(db, dir);
  });

  it('includes Key Knowledge section with only semantic memories when using static fallback', async () => {
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

    const keyKnowledgeIdx = ctx.indexOf('## Key Knowledge');
    if (keyKnowledgeIdx >= 0) {
      const nextSectionIdx = ctx.indexOf('\n##', keyKnowledgeIdx + 1);
      const section = nextSectionIdx >= 0 ? ctx.slice(keyKnowledgeIdx, nextSectionIdx) : ctx.slice(keyKnowledgeIdx);
      assert.ok(!section.includes('[episodic]'), 'Key Knowledge should not contain episodic memories');
    }
    cleanup(db, dir);
  });

  it('includes recent episodic memories in Recent Sessions', async () => {
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

    assert.ok(ctx.includes('Recent Sessions'));
    assert.ok(ctx.includes('authentication module'));
    cleanup(db, dir);
  });

  it('includes patterns section', async () => {
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

    assert.ok(ctx.includes('Patterns & Conventions'));
    assert.ok(ctx.includes('Error Handling Pattern'));
    cleanup(db, dir);
  });

  it('runs auto-consolidation after 10 sessions', async () => {
    db.setSessionMeta('session_count', '9');
    db.setSessionMeta('last_consolidation', '0');

    // Add some memories so consolidation has something to process
    seedMemory(db, 'sem-1', { type: 'semantic', content: 'fact one', importance: 0.5 }, 1);
    seedMemory(db, 'ep-1', { type: 'episodic', content: 'event one', importance: 0.5 }, 2);

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    // Should NOT include old "Consolidation Due" prompt — consolidation is now automated
    assert.ok(!ctx.includes('Consolidation Due'), 'Should not show old consolidation prompt');
    // Session count should be updated
    assert.ok(ctx.includes('session #10'));
    // last_consolidation should be updated
    assert.equal(db.getSessionMeta('last_consolidation'), '10');
    cleanup(db, dir);
  });

  it('auto-consolidation deletes stale memories', async () => {
    db.setSessionMeta('session_count', '9');
    db.setSessionMeta('last_consolidation', '0');

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

  it('includes relevance scores in Key Knowledge section', async () => {
    seedMemory(
      db,
      'sem-score',
      {
        type: 'semantic',
        title: 'Score Test',
        content: 'Memory with visible score',
        importance: 0.8,
      },
      1,
    );

    const result = await handleSessionStart(db, { cwd: '/a/bb' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    assert.ok(ctx.includes('*(score:'), 'Key Knowledge should include relevance score');
    assert.ok(/\*\(score: \d+\.\d{2}\)\*/.test(ctx), 'Score should be formatted as *(score: X.XX)*');
    cleanup(db, dir);
  });

  it('does not include score in Recent Sessions section', async () => {
    seedMemory(
      db,
      'ep-noscore',
      {
        type: 'episodic',
        content: 'Session without score indicator',
      },
      1,
    );

    const result = await handleSessionStart(db, { cwd: '/tmp/no-git-here-xyz' });
    assert.ok(result.hookSpecificOutput);
    const ctx = result.hookSpecificOutput.additionalContext;

    const recentIdx = ctx.indexOf('## Recent Sessions');
    if (recentIdx >= 0) {
      const nextSectionIdx = ctx.indexOf('\n##', recentIdx + 1);
      const section = nextSectionIdx >= 0 ? ctx.slice(recentIdx, nextSectionIdx) : ctx.slice(recentIdx);
      assert.ok(!section.includes('*(score:'), 'Recent Sessions should not include scores');
    }
    cleanup(db, dir);
  });

  it('does not trigger consolidation before 10 sessions', async () => {
    db.setSessionMeta('session_count', '3');
    db.setSessionMeta('last_consolidation', '0');

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
});
