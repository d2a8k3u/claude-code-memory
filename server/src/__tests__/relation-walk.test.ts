import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '../database.js';
import { expandByRelations } from '../cli/relation-walk.js';

function createTestDb(): MemoryDatabase {
  return new MemoryDatabase(':memory:');
}

function insert(
  db: MemoryDatabase,
  id: string,
  type: 'semantic' | 'pattern' | 'episodic' = 'semantic',
): void {
  const now = new Date().toISOString();
  db.insertMemory({
    id,
    type,
    title: id,
    content: id,
    context: null,
    source: null,
    tags: '[]',
    importance: 0.5,
    created_at: now,
    updated_at: now,
    access_count: 0,
    last_accessed: null,
    injection_count: 0,
    superseded_by: null,
  });
}

test('expandByRelations pulls in strong neighbours (weight >= 0.5)', () => {
  const db = createTestDb();
  try {
    insert(db, 'A');
    insert(db, 'B', 'pattern');
    insert(db, 'C');
    db.addRelation('A', 'B', 'relates_to', 0.7);
    db.addRelation('A', 'C', 'relates_to', 0.3); // weak — skipped

    const result = expandByRelations(db, ['A'], {
      maxNeighbors: 2,
      minWeight: 0.5,
      dedupSet: new Set(),
      typeCaps: {},
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].memory.id, 'B');
    assert.equal(result[0].relationType, 'relates_to');
  } finally {
    db.close();
  }
});

test('expandByRelations respects dedupSet', () => {
  const db = createTestDb();
  try {
    insert(db, 'A');
    insert(db, 'B');
    db.addRelation('A', 'B', 'extends', 0.8);

    const result = expandByRelations(db, ['A'], {
      maxNeighbors: 2,
      minWeight: 0.5,
      dedupSet: new Set(['B']),
      typeCaps: {},
    });

    assert.equal(result.length, 0);
  } finally {
    db.close();
  }
});

test('expandByRelations respects typeCaps', () => {
  const db = createTestDb();
  try {
    insert(db, 'A');
    insert(db, 'B', 'pattern');
    insert(db, 'C', 'pattern');
    db.addRelation('A', 'B', 'relates_to', 0.7);
    db.addRelation('A', 'C', 'relates_to', 0.6);

    const result = expandByRelations(db, ['A'], {
      maxNeighbors: 2,
      minWeight: 0.5,
      dedupSet: new Set(),
      typeCaps: { pattern: 1 },
    });

    assert.equal(result.length, 1, 'cap limits to 1 pattern');
  } finally {
    db.close();
  }
});

test('expandByRelations caps total at maxNeighbors', () => {
  const db = createTestDb();
  try {
    insert(db, 'A');
    for (const n of ['B', 'C', 'D']) {
      insert(db, n);
      db.addRelation('A', n, 'relates_to', 0.7);
    }

    const result = expandByRelations(db, ['A'], {
      maxNeighbors: 2,
      minWeight: 0.5,
      dedupSet: new Set(),
      typeCaps: {},
    });

    assert.equal(result.length, 2);
  } finally {
    db.close();
  }
});
