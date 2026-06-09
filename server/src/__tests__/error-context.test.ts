import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleErrorContext } from '../cli/error-context.js';
import { makeTempDb, cleanup, makeMemoryRow } from './helpers.js';

describe('handleErrorContext', () => {
  it('returns null for a non-Bash tool', () => {
    const { db, dir } = makeTempDb();
    const out = handleErrorContext(db, { tool_name: 'Read', tool_output: 'Error: boom' });
    assert.equal(out, null);
    cleanup(db, dir);
  });

  it('returns null when the Bash output has no error', () => {
    const { db, dir } = makeTempDb();
    const out = handleErrorContext(db, { tool_name: 'Bash', tool_output: 'All tests passed.' });
    assert.equal(out, null);
    cleanup(db, dir);
  });

  it('returns null when an error has no matching memory', () => {
    const { db, dir } = makeTempDb();
    const out = handleErrorContext(db, {
      tool_name: 'Bash',
      tool_output: 'TypeError: cannot read property of undefined in widget',
    });
    assert.equal(out, null);
    cleanup(db, dir);
  });

  it('surfaces a matching memory for a detected error', () => {
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

    const out = handleErrorContext(db, {
      tool_name: 'Bash',
      tool_output: 'ReferenceError: fetchWidget is not defined',
    });

    assert.ok(out, 'a hook output is produced');
    assert.equal(out!.hookSpecificOutput?.hookEventName, 'PostToolUse');
    assert.match(out!.hookSpecificOutput!.additionalContext, /Missing import fix/);
    cleanup(db, dir);
  });
});
