import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleErrorContext } from '../cli/error-context.js';
import { makeTempDb, cleanup, makeMemoryRow, makeEmbedding } from './helpers.js';

describe('handleErrorContext', () => {
  it('returns null for a non-Bash tool', async () => {
    const { db, dir } = makeTempDb();
    const out = await handleErrorContext(db, { tool_name: 'Read', tool_output: 'Error: boom' });
    assert.equal(out, null);
    cleanup(db, dir);
  });

  it('returns null when the Bash output has no error', async () => {
    const { db, dir } = makeTempDb();
    const out = await handleErrorContext(db, { tool_name: 'Bash', tool_output: 'All tests passed.' });
    assert.equal(out, null);
    cleanup(db, dir);
  });

  it('returns null when an error has no matching memory', async () => {
    const { db, dir } = makeTempDb();
    const out = await handleErrorContext(db, {
      tool_name: 'Bash',
      tool_output: 'TypeError: cannot read property of undefined in widget',
    });
    assert.equal(out, null);
    cleanup(db, dir);
  });

  it('surfaces a matching memory for a detected error (FTS path)', async () => {
    const { db, dir } = makeTempDb();
    // searchMemories is implicit-AND FTS, so the memory must share the error's
    // significant terms — store the known error phrase alongside the fix.
    db.insertMemory(
      makeMemoryRow({
        id: 'fix1',
        type: 'pattern',
        title: 'Missing import fix',
        content: 'Known fix: ReferenceError: fetchWidget is not defined — re-add the dropped import.',
      }),
    );

    // No embedder override and no real model in unit tests -> generateEmbedding
    // returns null, so this exercises the FTS-only degrade path.
    const out = await handleErrorContext(db, {
      tool_name: 'Bash',
      tool_output: 'ReferenceError: fetchWidget is not defined',
    });

    assert.ok(out, 'a hook output is produced');
    assert.equal(out!.hookSpecificOutput?.hookEventName, 'PostToolUse');
    assert.match(out!.hookSpecificOutput!.additionalContext, /Missing import fix/);
    cleanup(db, dir);
  });

  it('surfaces a paraphrased error via semantic recall where FTS would miss', async () => {
    const { db, dir } = makeTempDb();
    const vec = makeEmbedding(42);
    db.insertMemory(
      makeMemoryRow({
        id: 'fix2',
        type: 'pattern',
        title: 'Connection leak fix',
        content: 'The SQLite handle leaked because the session pool was never released after migration.',
        importance: 0.8,
      }),
    );
    db.updateMemoryEmbedding('fix2', vec);

    // The error uses an entirely different vocabulary/class than the memory, so the
    // FTS-only path misses it. A deterministic embedder maps the query to the same
    // vector the memory was seeded with, so the vector channel recalls it.
    const out = await handleErrorContext(
      db,
      { tool_name: 'Bash', tool_output: 'Error: resource exhausted while opening cursor' },
      async () => vec,
    );

    assert.ok(out, 'semantic recall produces a hook output for the paraphrased error');
    assert.match(out!.hookSpecificOutput!.additionalContext, /Connection leak fix/);
    cleanup(db, dir);
  });

  it('FTS path misses the paraphrased error when the embedding is unavailable', async () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'fix3',
        type: 'pattern',
        title: 'Connection leak fix',
        content: 'The SQLite handle leaked because the session pool was never released after migration.',
        importance: 0.8,
      }),
    );

    // generateEmbedding -> null degrades to FTS, which shares no significant terms
    // with the paraphrased error, so nothing surfaces.
    const out = await handleErrorContext(
      db,
      { tool_name: 'Bash', tool_output: 'Error: resource exhausted while opening cursor' },
      async () => null,
    );

    assert.equal(out, null);
    cleanup(db, dir);
  });

  it('still returns FTS matches when the embedding is unavailable', async () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'fix4',
        type: 'pattern',
        title: 'Missing import fix',
        content: 'Known fix: ReferenceError: fetchWidget is not defined — re-add the dropped import.',
      }),
    );

    const out = await handleErrorContext(
      db,
      { tool_name: 'Bash', tool_output: 'ReferenceError: fetchWidget is not defined' },
      async () => null,
    );

    assert.ok(out, 'FTS still matches when embeddings are unavailable');
    assert.match(out!.hookSpecificOutput!.additionalContext, /Missing import fix/);
    cleanup(db, dir);
  });
});
