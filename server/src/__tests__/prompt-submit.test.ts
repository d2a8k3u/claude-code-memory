import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDatabase } from '../database.js';
import { handlePromptSubmit } from '../cli/prompt-submit.js';
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

test('prompt-submit returns empty when prompt is too short', async () => {
  const cwd = tempCwd();
  const db = new MemoryDatabase(':memory:');
  try {
    const result = await handlePromptSubmit(db, { cwd, prompt: 'ok' });
    assert.equal(result.hookSpecificOutput?.additionalContext ?? '', '');
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('prompt-submit surfaces matching semantic memory for topical prompt', async () => {
  const cwd = tempCwd();
  const db = new MemoryDatabase(':memory:');
  try {
    const rec = makeMemoryRecord(
      'semantic',
      'The FTS5 index uses porter tokenizer for stemmed search.',
      ['fts', 'search'],
      { title: 'FTS5 tokenizer' },
    );
    rec.embedding = embeddingToBuffer(makeEmbedding(42));
    db.insertMemory(rec);
    // Embedding needs to be inserted via updateMemoryEmbedding too so vec index picks it up
    db.updateMemoryEmbedding(rec.id, makeEmbedding(42));

    const result = await handlePromptSubmit(db, {
      cwd,
      prompt: 'FTS5 porter tokenizer stemmed search index',
    });
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, /FTS5|tokenizer/i);
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('prompt-submit skips items already in session cache', async () => {
  const cwd = tempCwd();
  const db = new MemoryDatabase(':memory:');
  try {
    const rec = makeMemoryRecord(
      'semantic',
      'The FTS5 index uses porter tokenizer for stemmed search.',
      ['fts'],
      { title: 'FTS5' },
    );
    rec.embedding = embeddingToBuffer(makeEmbedding(42));
    db.insertMemory(rec);
    db.updateMemoryEmbedding(rec.id, makeEmbedding(42));

    const { resetCache, markInjected } = await import('../cli/session-cache.js');
    resetCache(cwd, 'test');
    markInjected(cwd, [rec.id]);

    const result = await handlePromptSubmit(db, {
      cwd,
      prompt: 'FTS5 porter tokenizer stemmed search index',
    });
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    // The cache filter must drop this memory entirely. We cannot test by `id`
    // because the formatter never includes the raw ID — assert via the title
    // and content keywords (which the formatter does include).
    assert.ok(!ctx.includes('FTS5'), 'cached memory title FTS5 must not appear');
    assert.ok(!ctx.includes('tokenizer'), 'cached memory content tokenizer must not appear');
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
