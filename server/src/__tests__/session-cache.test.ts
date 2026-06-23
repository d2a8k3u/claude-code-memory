import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCache,
  resetCache,
  markInjected,
  isInjected,
  deleteCache,
  CACHE_CAP,
  formatBadge,
  writeStatusline,
  readBadge,
} from '../cli/session-cache.js';

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), 'cm-test-'));
}

test('resetCache creates a fresh cache with given session_id', () => {
  const cwd = tempCwd();
  try {
    resetCache(cwd, 'sess-1');
    const cache = loadCache(cwd);
    assert.equal(cache.session_id, 'sess-1');
    assert.deepEqual(cache.injected_ids, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('markInjected appends IDs; isInjected checks membership', () => {
  const cwd = tempCwd();
  try {
    resetCache(cwd, 'sess-1');
    markInjected(cwd, ['a', 'b', 'c']);
    const cache = loadCache(cwd);
    assert.deepEqual(cache.injected_ids, ['a', 'b', 'c']);
    assert.ok(isInjected(cache, 'b'));
    assert.ok(!isInjected(cache, 'z'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('markInjected dedups existing IDs', () => {
  const cwd = tempCwd();
  try {
    resetCache(cwd, 'sess-1');
    markInjected(cwd, ['a', 'b']);
    markInjected(cwd, ['b', 'c']);
    const cache = loadCache(cwd);
    assert.deepEqual(cache.injected_ids, ['a', 'b', 'c']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('markInjected evicts FIFO when over cap', () => {
  const cwd = tempCwd();
  try {
    resetCache(cwd, 'sess-1');
    const ids = Array.from({ length: CACHE_CAP + 10 }, (_, i) => `id_${i}`);
    markInjected(cwd, ids);
    const cache = loadCache(cwd);
    assert.equal(cache.injected_ids.length, CACHE_CAP);
    assert.ok(!cache.injected_ids.includes('id_0'));
    assert.ok(cache.injected_ids.includes(`id_${CACHE_CAP + 9}`));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadCache returns empty cache when file missing', () => {
  const cwd = tempCwd();
  try {
    const cache = loadCache(cwd);
    assert.deepEqual(cache.injected_ids, []);
    assert.equal(cache.session_id, '');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadCache tolerates corrupt file', () => {
  const cwd = tempCwd();
  try {
    mkdirSync(join(cwd, '.claude', 'memory-db'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'memory-db', 'session-cache.json'), '{corrupt');
    const cache = loadCache(cwd);
    assert.deepEqual(cache.injected_ids, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('formatBadge labels loaded over corpus; empty corpus reads as zero', () => {
  assert.equal(formatBadge(4, 120), '🧠 4 loaded / 120');
  assert.equal(formatBadge(0, 0), '🧠 0 loaded');
  assert.equal(formatBadge(7, 0), '🧠 0 loaded');
});

test('readBadge returns default when flat file missing', () => {
  const cwd = tempCwd();
  try {
    assert.equal(readBadge(cwd), '🧠 0 loaded');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeStatusline then readBadge round-trips the badge', () => {
  const cwd = tempCwd();
  try {
    writeStatusline(cwd, 4, 120);
    assert.equal(readBadge(cwd), '🧠 4 loaded / 120');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('readBadge tolerates a corrupt flat file', () => {
  const cwd = tempCwd();
  try {
    mkdirSync(join(cwd, '.claude', 'memory-db'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'memory-db', '.statusline'), 'garbage');
    assert.equal(readBadge(cwd), '🧠 0 loaded');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('deleteCache removes the cache file', () => {
  const cwd = tempCwd();
  try {
    resetCache(cwd, 'sess');
    deleteCache(cwd);
    const cache = loadCache(cwd);
    assert.deepEqual(cache.injected_ids, []);
    assert.equal(cache.session_id, '');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
