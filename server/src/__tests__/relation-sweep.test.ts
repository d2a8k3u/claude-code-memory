import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '../database.js';

function createTestDb(): MemoryDatabase {
  return new MemoryDatabase(':memory:');
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

function seedMemory(db: MemoryDatabase, id: string, seed: number): void {
  const now = new Date().toISOString();
  db.insertMemory({
    id,
    type: 'semantic',
    title: id,
    content: `content ${id}`,
    context: null,
    source: null,
    tags: '[]',
    importance: 0.5,
    created_at: now,
    updated_at: now,
    access_count: 0,
    last_accessed: null,
    injection_count: 0,
  });
  db.updateMemoryEmbedding(id, makeEmbedding(seed));
}

test('sweepRelations processes under-connected nodes and creates relations', () => {
  const db = createTestDb();
  try {
    // Seeds vary by 0.001 → embeddings are extremely close (cosine distance well
    // below 0.15) so the contradicts branch must produce relations.
    for (let i = 0; i < 3; i++) {
      seedMemory(db, `S${i}`, i * 0.001);
    }
    const result = db.sweepRelations({ batchSize: 100, neighborCandidates: 10, timeBudgetMs: 500 });
    assert.equal(result.processed, 3, 'must process all 3 candidates');
    assert.ok(result.created > 0, 'must actually create at least one relation, not just process');
    // Verify a relation exists post-sweep.
    const relS0 = db.getRelations('S0');
    assert.ok(relS0.length > 0, 'S0 must have at least one relation after sweep');
    assert.equal(db.getSessionMeta('last_sweep_session'), '0');
  } finally {
    db.close();
  }
});

test('decayRelationWeights reduces weight uniformly', () => {
  const db = createTestDb();
  try {
    seedMemory(db, 'A', 1);
    seedMemory(db, 'B', 2);
    db.addRelation('A', 'B', 'extends', 0.5);
    db.decayRelationWeights();
    const rel = db.getRelations('A').find((r) => r.target_id === 'B');
    assert.ok(rel && rel.weight < 0.5);
  } finally {
    db.close();
  }
});

test('boostRelationOnCoInject increases weight', () => {
  const db = createTestDb();
  try {
    seedMemory(db, 'A', 1);
    seedMemory(db, 'B', 2);
    db.addRelation('A', 'B', 'extends', 0.5);
    db.boostRelationOnCoInject('A', 'B');
    const rel = db.getRelations('A').find((r) => r.target_id === 'B');
    assert.ok(rel && rel.weight > 0.5);
  } finally {
    db.close();
  }
});

test('pruneStaleRelations removes links with weight below floor and unused endpoints', () => {
  const db = createTestDb();
  try {
    seedMemory(db, 'A', 1);
    seedMemory(db, 'B', 2);
    db.addRelation('A', 'B', 'relates_to', 0.02);
    db.pruneStaleRelations();
    assert.equal(db.getRelations('A').length, 0);
  } finally {
    db.close();
  }
});
