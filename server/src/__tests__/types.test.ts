import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rowToMemory } from '../types.js';
import type { MemoryRow } from '../types.js';

function makeRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 'test-id',
    type: 'semantic',
    title: null,
    content: 'test content',
    context: null,
    source: null,
    tags: '[]',
    importance: 0.5,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    access_count: 0,
    last_accessed: null,
    injection_count: 0,
    ...overrides,
  };
}

describe('rowToMemory', () => {
  it('converts a MemoryRow to Memory with parsed tags', () => {
    const row = makeRow({
      id: 'mem-123',
      type: 'semantic',
      title: 'TypeScript Guide',
      content: 'A guide about TypeScript',
      context: 'project setup',
      source: 'README.md',
      tags: '["typescript","guide"]',
      importance: 0.8,
      access_count: 5,
      last_accessed: '2024-06-01T00:00:00.000Z',
    });

    const memory = rowToMemory(row);

    assert.equal(memory.id, 'mem-123');
    assert.equal(memory.type, 'semantic');
    assert.equal(memory.title, 'TypeScript Guide');
    assert.equal(memory.content, 'A guide about TypeScript');
    assert.equal(memory.context, 'project setup');
    assert.equal(memory.source, 'README.md');
    assert.deepEqual(memory.tags, ['typescript', 'guide']);
    assert.equal(memory.importance, 0.8);
    assert.equal(memory.access_count, 5);
    assert.equal(memory.last_accessed, '2024-06-01T00:00:00.000Z');
  });

  it('handles empty tags array', () => {
    const memory = rowToMemory(makeRow({ tags: '[]' }));
    assert.deepEqual(memory.tags, []);
  });

  it('handles null fields', () => {
    const memory = rowToMemory(
      makeRow({
        title: null,
        context: null,
        source: null,
        last_accessed: null,
      }),
    );

    assert.equal(memory.title, null);
    assert.equal(memory.context, null);
    assert.equal(memory.source, null);
    assert.equal(memory.last_accessed, null);
  });

  it('casts type string to MemoryType for all valid types', () => {
    for (const type of ['episodic', 'semantic', 'procedural', 'working', 'pattern']) {
      const memory = rowToMemory(makeRow({ type }));
      assert.equal(memory.type, type);
    }
  });

  it('parses tags with special characters', () => {
    const memory = rowToMemory(
      makeRow({
        tags: '["bug-fix","api-v2","c++"]',
      }),
    );
    assert.deepEqual(memory.tags, ['bug-fix', 'api-v2', 'c++']);
  });

  it('preserves all numeric fields', () => {
    const memory = rowToMemory(
      makeRow({
        importance: 0.95,
        access_count: 42,
      }),
    );
    assert.equal(memory.importance, 0.95);
    assert.equal(memory.access_count, 42);
  });

  it('preserves date strings', () => {
    const memory = rowToMemory(
      makeRow({
        created_at: '2024-01-15T10:30:00.000Z',
        updated_at: '2024-06-20T15:45:00.000Z',
      }),
    );
    assert.equal(memory.created_at, '2024-01-15T10:30:00.000Z');
    assert.equal(memory.updated_at, '2024-06-20T15:45:00.000Z');
  });
});
