import { MemoryDatabase } from '../database.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRow } from '../types.js';

export function makeTempDb(): { db: MemoryDatabase; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-test-'));
  const dbPath = join(dir, 'memory.sqlite');
  return { db: new MemoryDatabase(dbPath), dir };
}

export function makeEmbedding(seed: number): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.sin(seed * 1000 + i) * 0.5;
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

export function cleanup(db: MemoryDatabase, dir: string): void {
  db.close();
  rmSync(dir, { recursive: true });
}

const NOW = new Date().toISOString();

export function makeMemoryRow(overrides: Partial<MemoryRow> & { id: string }): MemoryRow {
  return {
    type: 'semantic',
    title: null,
    content: 'test content',
    context: null,
    source: null,
    tags: '[]',
    importance: 0.5,
    created_at: NOW,
    updated_at: NOW,
    access_count: 0,
    last_accessed: null,
    injection_count: 0,
    ...overrides,
  };
}
