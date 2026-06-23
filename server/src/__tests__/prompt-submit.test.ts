import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDatabase } from '../database.js';
import { handlePromptSubmit } from '../cli/prompt-submit.js';
import { makeMemoryRecord } from '../cli/shared.js';
import { embeddingToBuffer, generateEmbedding, isEmbeddingsAvailable } from '../embeddings.js';

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

/** Insert an episodic carrying a real-model embedding so the vector channel can match. */
async function insertEpisodicWithEmbedding(
  db: MemoryDatabase,
  content: string,
  importance: number,
  ageDays = 0,
): Promise<void> {
  const rec = makeMemoryRecord('episodic', content, ['x'], { importance });
  if (ageDays > 0) {
    const iso = new Date(Date.now() - ageDays * 86_400_000).toISOString();
    rec.created_at = iso;
    rec.updated_at = iso;
  }
  const emb = await generateEmbedding(content);
  assert.ok(emb, 'precondition: embedding model must produce a vector');
  rec.embedding = embeddingToBuffer(emb);
  db.insertMemory(rec);
  db.updateMemoryEmbedding(rec.id, emb);
}

// Always-on episodic recall is topically gated: a recent-but-off-topic episodic that
// only matches via the FTS floor (textScore 0.05) must NOT ride recency+importance over
// the line, even though the old recall-only path with the 0.25 blended threshold did
// inject it. This case is model-independent (no embedding -> FTS-only).
test('prompt-submit does NOT inject a recent off-topic episodic on a normal prompt', async () => {
  const cwd = tempCwd();
  const db = new MemoryDatabase(':memory:');
  try {
    // No embedding => FTS-only. A single-word prompt FTS-matches the shared word
    // "authentication" at the floor (textScore 0.05), and importance 0.5 keeps the
    // blended score at 0.425 — under the old 0.25 threshold this WOULD have surfaced.
    const rec = makeMemoryRecord(
      'episodic',
      'We celebrated the project authentication milestone with cake and balloons.',
      ['party'],
      { importance: 0.5 },
    );
    db.insertMemory(rec);

    const result = await handlePromptSubmit(db, { cwd, prompt: 'authentication' });
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(!ctx.includes('cake'), 'off-topic FTS-floor episodic must not be injected on a normal prompt');
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('prompt-submit injects an on-topic episodic on a normal (non-recall) prompt', async (t) => {
  if (!(await isEmbeddingsAvailable())) {
    t.skip('embedding model unavailable — on-topic match needs the vector channel');
    return;
  }
  const cwd = tempCwd();
  const db = new MemoryDatabase(':memory:');
  try {
    await insertEpisodicWithEmbedding(
      db,
      'We fixed the SQLite FTS5 porter tokenizer indexing bug in the hybrid search query builder.',
      0.5,
    );
    const result = await handlePromptSubmit(db, {
      cwd,
      prompt: 'fix the SQLite FTS5 porter tokenizer bug in hybrid search',
    });
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('tokenizer'), 'on-topic episodic must be injected on a normal prompt');
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// On an explicit recall prompt the gate relaxes back toward the old 0.25 threshold, so a
// recall prompt injects at least as much history as before: an aged, weakly-topical
// episodic that the higher always-on baseline filters out of a normal prompt must
// reappear on a "did we already…" prompt (alongside the strong on-topic one).
test('prompt-submit recall prompt injects at least as much episodic history as a normal prompt', async (t) => {
  if (!(await isEmbeddingsAvailable())) {
    t.skip('embedding model unavailable — relies on the vector channel for topical scoring');
    return;
  }
  const strong = 'We fixed the SQLite FTS5 porter tokenizer indexing bug in the hybrid search query builder.';
  const weak = 'We ran the database migration scripts and verified the schema upgrade earlier.';
  const normalPrompt = 'fix the SQLite FTS5 porter tokenizer bug in hybrid search';
  const recallPrompt = 'did we already fix the SQLite FTS5 tokenizer hybrid search and the database migration?';

  async function injectedKeywords(prompt: string): Promise<Set<string>> {
    const cwd = tempCwd();
    const db = new MemoryDatabase(':memory:');
    try {
      await insertEpisodicWithEmbedding(db, strong, 0.5);
      await insertEpisodicWithEmbedding(db, weak, 0.5, 20);
      const result = await handlePromptSubmit(db, { cwd, prompt });
      const ctx = result.hookSpecificOutput?.additionalContext ?? '';
      const hits = new Set<string>();
      if (ctx.includes('tokenizer')) hits.add('tokenizer');
      if (ctx.includes('migration')) hits.add('migration');
      return hits;
    } finally {
      db.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  const normalHits = await injectedKeywords(normalPrompt);
  const recallHits = await injectedKeywords(recallPrompt);

  assert.ok(recallHits.has('tokenizer'), 'recall prompt must still inject the strong on-topic episodic');
  assert.ok(
    recallHits.size >= normalHits.size,
    `recall must inject at least as much history (recall ${recallHits.size} >= normal ${normalHits.size})`,
  );
  assert.ok(
    recallHits.has('migration') && !normalHits.has('migration'),
    'the aged weakly-topical episodic should surface only under the relaxed recall gate',
  );
});
