import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '../database.js';
import { rewriteLegacyTitles } from '../cli/cleanup.js';

function createTestDb(): MemoryDatabase {
  return new MemoryDatabase(':memory:');
}

test('rewriteLegacyTitles converts **Task:** prefix content into prose', async () => {
  const db = createTestDb();
  try {
    const now = new Date().toISOString();
    db.insertMemory({
      id: 'LEGACY1',
      type: 'episodic',
      title: null,
      content: '**Task:** Refactor parser\n**Tools:** Edit\n**Files modified:** a.ts',
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
    const { rewritten } = await rewriteLegacyTitles(db);
    assert.equal(rewritten, 1);
    const row = db.getMemoryByIdRaw('LEGACY1')!;
    assert.ok(row.title && row.title.length > 0);
    assert.doesNotMatch(row.content, /^\s*\*\*Task:\*\*/);
  } finally {
    db.close();
  }
});

test('rewriteLegacyTitles ignores already-clean episodics', async () => {
  const db = createTestDb();
  try {
    const now = new Date().toISOString();
    db.insertMemory({
      id: 'CLEAN1',
      type: 'episodic',
      title: 'Refactored parser',
      content: 'Refactored parser. Touched 1 file: a.ts.',
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
    const { rewritten } = await rewriteLegacyTitles(db);
    assert.equal(rewritten, 0);
  } finally {
    db.close();
  }
});
