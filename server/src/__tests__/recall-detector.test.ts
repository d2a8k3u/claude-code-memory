import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRecallStyle } from '../cli/recall-detector.js';

test('English "did we..." phrases detected', () => {
  assert.ok(isRecallStyle('Did we already discuss the FTS tokenizer?'));
  assert.ok(isRecallStyle('Remember the fix we applied last session?'));
  assert.ok(isRecallStyle('What did we decide about SQLite?'));
});

test('Non-recall prompts return false', () => {
  assert.equal(isRecallStyle('Refactor the transcript parser.'), false);
  assert.equal(isRecallStyle('Please add logging to the hook.'), false);
  assert.equal(isRecallStyle('What are the main components of this plugin?'), false);
});

test('Empty / very short prompts return false', () => {
  assert.equal(isRecallStyle(''), false);
  assert.equal(isRecallStyle('ok'), false);
});
