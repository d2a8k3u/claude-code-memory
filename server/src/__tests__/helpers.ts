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

/**
 * Returns a unit vector a controlled distance from `base`. Larger `epsilon`
 * yields a larger cosine distance. Deterministic (no RNG) so tests can assert
 * precise neighbour ordering — unlike makeEmbedding(seed), whose pairwise
 * distances are arbitrary.
 */
export function makeNearEmbedding(base: Float32Array, epsilon: number): Float32Array {
  const arr = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    arr[i] = base[i] + epsilon * Math.sin(i * 12.9898);
  }
  let norm = 0;
  for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < arr.length; i++) arr[i] /= norm;
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
    superseded_by: null,
    ...overrides,
  };
}
