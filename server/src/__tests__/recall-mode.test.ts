import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MemoryDatabase } from '../database.js';
import { getRecallMode, setRecallMode } from '../cli/recall-mode.js';
import { handleSessionStart } from '../cli/session-start.js';
import { handlePromptSubmit } from '../cli/prompt-submit.js';
import { handlePreToolUse } from '../cli/pre-tool-use.js';
import { handleErrorContext } from '../cli/error-context.js';
import { makeMemoryRecord } from '../cli/shared.js';

function tempCwd(): string {
  return process.cwd();
}

function ctx(out: { hookSpecificOutput?: { additionalContext: string } } | null): string {
  return out?.hookSpecificOutput?.additionalContext ?? '';
}

test('recall mode defaults to normal when unset', () => {
  const db = new MemoryDatabase(':memory:');
  try {
    assert.equal(getRecallMode(db), 'normal');
  } finally {
    db.close();
  }
});

test('setting recall mode off then reading returns off', () => {
  const db = new MemoryDatabase(':memory:');
  try {
    setRecallMode(db, 'off');
    assert.equal(getRecallMode(db), 'off');
    setRecallMode(db, 'normal');
    assert.equal(getRecallMode(db), 'normal');
  } finally {
    db.close();
  }
});

test('session-start injects a header in normal mode but nothing when off', async () => {
  const db = new MemoryDatabase(':memory:');
  try {
    const normal = await handleSessionStart(db, { cwd: tempCwd(), source: 'startup' });
    assert.ok(ctx(normal).length > 0, 'normal mode produces a memory-context header');

    setRecallMode(db, 'off');
    const off = await handleSessionStart(db, { cwd: tempCwd(), source: 'startup' });
    assert.equal(ctx(off), '');
  } finally {
    db.close();
  }
});

test('prompt-submit surfaces a match in normal mode but nothing when off', async () => {
  const db = new MemoryDatabase(':memory:');
  try {
    const rec = makeMemoryRecord('semantic', 'The FTS5 index uses porter tokenizer for stemmed search.', ['fts'], {
      title: 'FTS5 tokenizer',
    });
    db.insertMemory(rec);

    const prompt = 'FTS5 porter tokenizer stemmed search index';
    const normal = await handlePromptSubmit(db, { cwd: tempCwd(), prompt });
    assert.ok(ctx(normal).length > 0, 'normal mode surfaces the matching semantic memory');

    setRecallMode(db, 'off');
    const off = await handlePromptSubmit(db, { cwd: tempCwd(), prompt });
    assert.equal(ctx(off), '');
  } finally {
    db.close();
  }
});

test('pre-tool-use surfaces a pattern in normal mode but nothing when off', async () => {
  const db = new MemoryDatabase(':memory:');
  try {
    const rec = makeMemoryRecord(
      'pattern',
      'memory memory memory memory memory.ts memory.ts maxLength Zod rejected server src',
      ['correction', 'memory'],
      { title: 'No maxLength rule', importance: 1.0 },
    );
    db.insertMemory(rec);

    const toolInput = { file_path: 'server/src/memory.ts', old_string: 'x', new_string: 'y' };
    const normal = await handlePreToolUse(db, { cwd: tempCwd(), tool_name: 'Edit', tool_input: toolInput });
    assert.ok(ctx(normal).length > 0, 'normal mode surfaces the matching pattern memory');

    setRecallMode(db, 'off');
    const off = await handlePreToolUse(db, { cwd: tempCwd(), tool_name: 'Edit', tool_input: toolInput });
    assert.equal(ctx(off), '');
  } finally {
    db.close();
  }
});

test('error-context surfaces a match in normal mode but nothing when off', async () => {
  const db = new MemoryDatabase(':memory:');
  try {
    db.insertMemory(
      makeMemoryRecord(
        'pattern',
        'Known fix: ReferenceError: fetchWidget is not defined — re-add the dropped import.',
        ['error'],
        { title: 'Missing import fix' },
      ),
    );

    const input = { tool_name: 'Bash', tool_output: 'ReferenceError: fetchWidget is not defined' };
    const normal = await handleErrorContext(db, input);
    assert.ok(normal && ctx(normal).length > 0, 'normal mode surfaces the matching error memory');

    setRecallMode(db, 'off');
    const off = await handleErrorContext(db, input);
    assert.equal(off, null);
  } finally {
    db.close();
  }
});

test('recall-mode CLI subcommand does not hang with no stdin', async () => {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, 'recall-mode', 'status'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('recall-mode hung waiting on stdin'));
    }, 15_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  assert.equal(exitCode, 0, 'recall-mode status exits cleanly without stdin');
});
