import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '../database.js';
import {
  extractUserCorrection,
  extractNewFact,
  extractAll,
} from '../cli/turn-extractor.js';
import type { TurnContext } from '../cli/turn-extractor.js';

function createTestDb(): MemoryDatabase {
  return new MemoryDatabase(':memory:');
}

function ctx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    userMessage: '',
    assistantReply: '',
    toolCalls: [],
    filesRead: [],
    filesWritten: [],
    errorCount: 0,
    sessionId: 'sess-1',
    turnIndex: 0,
    ...overrides,
  };
}

test('extractUserCorrection produces a pattern candidate from English correction', () => {
  const c = extractUserCorrection(
    ctx({
      userMessage: "Don't use maxLength on Zod schemas, user rejected that already.",
      assistantReply: 'Added maxLength: 500 to content schema.',
      toolCalls: [{ name: 'Edit', input: { file_path: 'server/src/memory.ts' }, output: 'ok' }],
    }),
  );
  assert.ok(c, 'candidate should be produced');
  assert.equal(c!.type, 'pattern');
  assert.ok(c!.importance >= 0.7);
  const tags = JSON.parse(c!.tags);
  assert.ok(tags.includes('correction'));
});

test('extractUserCorrection returns null when user message has no signal', () => {
  const c = extractUserCorrection(
    ctx({
      userMessage: 'Can you add a logging statement?',
      assistantReply: 'Added logging.',
      toolCalls: [{ name: 'Edit', input: { file_path: 'a.ts' }, output: 'ok' }],
    }),
  );
  assert.equal(c, null);
});

test('extractUserCorrection ignores bare "don\'t" / "actually" non-corrections', () => {
  // "I don't know" previously matched bare /don't/ and produced a junk pattern.
  assert.equal(
    extractUserCorrection(
      ctx({
        userMessage: "I don't know how this works, can you explain?",
        toolCalls: [{ name: 'Edit', input: { file_path: 'a.ts' }, output: 'ok' }],
      }),
    ),
    null,
  );
  // "actually" previously matched on its own.
  assert.equal(
    extractUserCorrection(
      ctx({
        userMessage: 'Actually that makes sense, thanks.',
        toolCalls: [{ name: 'Edit', input: { file_path: 'a.ts' }, output: 'ok' }],
      }),
    ),
    null,
  );
});

test('extractUserCorrection still fires on an imperative "don\'t <verb>" directive', () => {
  const c = extractUserCorrection(
    ctx({
      userMessage: "Don't hardcode the path, use a config value instead.",
      toolCalls: [{ name: 'Edit', input: { file_path: 'a.ts' }, output: 'ok' }],
    }),
  );
  assert.ok(c, 'imperative correction still detected');
  assert.equal(c!.type, 'pattern');
});

test('extractNewFact emits semantic when unknown module is mentioned', async () => {
  const db = createTestDb();
  try {
    const c = await extractNewFact(
      ctx({
        assistantReply: "server/src/cli/pattern-detector.ts hosts cluster quality scoring.",
        toolCalls: [{ name: 'Grep', input: { pattern: 'foo' }, output: 'server/src/cli/pattern-detector.ts:...' }],
      }),
      db,
    );
    assert.ok(c, 'should emit semantic candidate for unknown module');
    assert.equal(c!.type, 'semantic');
  } finally {
    db.close();
  }
});

test('extractAll returns empty array for noop turn', async () => {
  const db = createTestDb();
  try {
    const results = await extractAll(ctx({ userMessage: 'thanks', assistantReply: 'ok' }), db);
    assert.deepEqual(results, []);
  } finally {
    db.close();
  }
});
