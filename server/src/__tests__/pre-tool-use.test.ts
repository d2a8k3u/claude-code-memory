import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDatabase } from '../database.js';
import { handlePreToolUse } from '../cli/pre-tool-use.js';
import { makeMemoryRecord } from '../cli/shared.js';
import { embeddingToBuffer } from '../embeddings.js';

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), 'cm-test-'));
}

function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i);
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}

test('pre-tool-use on Edit surfaces pattern for touched path', async () => {
  const cwd = tempCwd();
  const db = new MemoryDatabase(':memory:');
  try {
    const rec = makeMemoryRecord(
      'pattern',
      'memory memory memory memory memory.ts memory.ts maxLength Zod rejected server src',
      ['correction', 'memory', 'zod'],
      { title: 'No maxLength rule', importance: 1.0 },
    );
    rec.embedding = embeddingToBuffer(makeEmbedding(7));
    db.insertMemory(rec);
    db.updateMemoryEmbedding(rec.id, makeEmbedding(7));

    const result = await handlePreToolUse(db, {
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: 'server/src/memory.ts', old_string: 'x', new_string: 'y' },
    });
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.length > 0, 'Edit hook must surface a matching pattern memory (FTS hit on memory.ts)');
    assert.match(ctx, /Memory check before Edit|memory\.ts|maxLength/i);
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('pre-tool-use on Bash with "npm test" returns procedural workflow if any', async () => {
  const cwd = tempCwd();
  const db = new MemoryDatabase(':memory:');
  try {
    // findMemoryByTag matches by tag; the category tag is set by makeMemoryRecord opts? No —
    // tags are the array passed in. Use 'test' as a tag so findMemoryByTag('procedural', 'test') hits.
    const rec = makeMemoryRecord(
      'procedural',
      'Test workflow: npm run build && npm test',
      ['auto-procedural', 'test'],
      { title: 'Test workflow' },
    );
    db.insertMemory(rec);

    const result = await handlePreToolUse(db, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    const out = result.hookSpecificOutput?.additionalContext ?? '';
    assert.match(out, /Test workflow|npm test/i);
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('pre-tool-use returns empty for unknown tool', async () => {
  const cwd = tempCwd();
  const db = new MemoryDatabase(':memory:');
  try {
    const result = await handlePreToolUse(db, {
      cwd,
      tool_name: 'SomeCustomTool',
      tool_input: {},
    });
    assert.equal(result.hookSpecificOutput?.additionalContext ?? '', '');
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
