import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '../database.js';
import { embeddingToBuffer } from '../embeddings.js';
import { insertWithAutoRelations } from '../memory.js';
import { makeMemoryRecord } from '../cli/shared.js';

function createTestDb(): MemoryDatabase {
  return new MemoryDatabase(':memory:');
}

function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i) * 0.5;
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}

test('insertWithAutoRelations inserts a clean record and returns isNew=true', async () => {
  const db = createTestDb();
  try {
    const rec = makeMemoryRecord('semantic', 'Project uses SQLite for persistence.', ['tech-stack'], {
      title: 'SQLite persistence',
    });
    rec.embedding = embeddingToBuffer(makeEmbedding(1));
    const result = await insertWithAutoRelations(db, rec);
    assert.equal(result.isNew, true);
    assert.equal(result.id, rec.id);
    assert.equal(result.relationsCreated, 0);
  } finally {
    db.close();
  }
});

test('insertWithAutoRelations rejects content starting with meta-prefix in plugin-path mode', async () => {
  const db = createTestDb();
  try {
    const rec = makeMemoryRecord('episodic', '**Task:** Refactored X\n**Files:** y.ts', ['auto-save']);
    rec.embedding = embeddingToBuffer(makeEmbedding(2));
    await assert.rejects(
      () => insertWithAutoRelations(db, rec, { strictContent: true }),
      /meta-prefix/,
    );
  } finally {
    db.close();
  }
});

test('insertWithAutoRelations merges near-duplicate instead of inserting twice', async () => {
  const db = createTestDb();
  try {
    const rec1 = makeMemoryRecord('semantic', 'Project uses SQLite.', ['tech']);
    const emb = makeEmbedding(3);
    rec1.embedding = embeddingToBuffer(emb);
    await insertWithAutoRelations(db, rec1);

    const rec2 = makeMemoryRecord('semantic', 'Project uses SQLite.', ['tech', 'db']);
    rec2.embedding = embeddingToBuffer(emb);
    const result = await insertWithAutoRelations(db, rec2);

    assert.equal(result.isNew, false);
    assert.equal(result.id, rec1.id, 'should merge into first record');
  } finally {
    db.close();
  }
});

test('insertWithAutoRelations creates extends relation for same-type moderate similarity', async () => {
  const db = createTestDb();
  try {
    const rec1 = makeMemoryRecord('semantic', 'Semantic memory note A.', ['x']);
    rec1.embedding = embeddingToBuffer(makeEmbedding(10));
    await insertWithAutoRelations(db, rec1);

    const e1 = makeEmbedding(10);
    const e2 = makeEmbedding(10);
    for (let i = 0; i < 50; i++) e2[i] = -e2[i];
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += e2[i] * e2[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) e2[i] /= norm;

    const rec2 = makeMemoryRecord('semantic', 'Semantic note B (related but distinct).', ['y']);
    rec2.embedding = embeddingToBuffer(e2);
    const result = await insertWithAutoRelations(db, rec2);
    assert.equal(result.isNew, true);

    const relations = db.getRelations(rec2.id);
    const extendsRel = relations.find((r) => r.relation_type === 'extends');
    assert.ok(extendsRel, 'should create extends relation to rec1');
  } finally {
    db.close();
  }
});

test('insertWithAutoRelations caps relations at 5 — exact cap is enforced', async () => {
  const db = createTestDb();
  try {
    // Build 7 same-type embeddings each with a different 50-component slice
    // flipped, plus a final (un-flipped) record. Each pair (final, pre-inserted i)
    // differs in 50/384 components → cosine distance ≈ 0.26 (extends range).
    // Each pair (i, j) differs in 100/384 components → distance ≈ 0.52
    // (well above the dedup threshold, so no merging).
    const baseSeed = 200;
    function withFlippedSlice(start: number, length: number): Float32Array {
      const v = makeEmbedding(baseSeed);
      for (let i = start; i < Math.min(start + length, 384); i++) v[i] = -v[i];
      let n = 0;
      for (let i = 0; i < 384; i++) n += v[i] * v[i];
      n = Math.sqrt(n);
      for (let i = 0; i < 384; i++) v[i] /= n;
      return v;
    }
    for (let i = 0; i < 7; i++) {
      const rec = makeMemoryRecord('semantic', `note ${i}`, ['t']);
      rec.embedding = embeddingToBuffer(withFlippedSlice(i * 50, 50));
      await insertWithAutoRelations(db, rec);
    }
    const rec = makeMemoryRecord('semantic', 'note final', ['t']);
    rec.embedding = embeddingToBuffer(makeEmbedding(baseSeed));
    const result = await insertWithAutoRelations(db, rec);

    assert.ok(result.relationsCreated > 0, 'precondition: candidate relations must be produced');
    assert.equal(result.relationsCreated, 5, 'must cap relations at exactly 5');
  } finally {
    db.close();
  }
});
