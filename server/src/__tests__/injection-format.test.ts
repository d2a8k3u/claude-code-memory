import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMemoryLine,
  formatBlock,
  formatWarningBlock,
  formatBlockWithRelations,
} from '../cli/injection-format.js';
import type { MemoryRow } from '../types.js';

function mk(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 'ULIDXYZ',
    type: 'pattern',
    title: 'User rule',
    content: 'No maxLength on Zod memory schemas — user rejected 2026-03-15.',
    context: null,
    source: null,
    tags: '[]',
    importance: 0.78,
    created_at: '2026-03-15T12:00:00Z',
    updated_at: '2026-03-15T12:00:00Z',
    access_count: 0,
    last_accessed: null,
    injection_count: 0,
    ...overrides,
  };
}

test('formatMemoryLine strips markdown in title', () => {
  const line = formatMemoryLine(mk({ title: '**Bold** _title_' }));
  assert.doesNotMatch(line, /\*\*|_/);
});

test('formatMemoryLine marks high-importance patterns with star', () => {
  const line = formatMemoryLine(mk({ importance: 0.8 }));
  assert.match(line, /★/);
});

test('formatMemoryLine does not star low-importance', () => {
  const line = formatMemoryLine(mk({ importance: 0.5 }));
  assert.doesNotMatch(line, /★/);
});

test('formatMemoryLine shows date for episodic', () => {
  const line = formatMemoryLine(mk({ type: 'episodic', created_at: '2026-04-20T10:00:00Z' }));
  assert.match(line, /\[episodic 2026-04-20\]/);
});

test('formatBlock wraps lines with auto-recalled header', () => {
  const block = formatBlock([mk()], { sessionNum: 80 });
  assert.match(block, /## Memory \(session #80, auto-recalled\)/);
});

test('formatWarningBlock produces Edit-style warning', () => {
  const block = formatWarningBlock(mk(), 'server/src/memory.ts');
  assert.match(block, /## Memory check before Edit/);
  assert.match(block, /server\/src\/memory\.ts/);
  assert.match(block, /⚠️/);
});

test('formatBlock returns empty string for empty input', () => {
  assert.equal(formatBlock([], { sessionNum: 1 }), '');
});

test('formatBlockWithRelations indents neighbours under their primary with relation type', () => {
  const primary = mk({ id: 'P1', title: 'Primary rule' });
  const neighbour = mk({ id: 'N1', type: 'semantic', title: 'Related note', importance: 0.5 });
  const block = formatBlockWithRelations(
    [primary],
    [{ memory: neighbour, relationType: 'derived_from' }],
    { sessionNum: 80 },
  );
  assert.match(block, /Primary rule/);
  assert.match(block, /Related note/);
  assert.match(block, /→ derived_from/);
});
