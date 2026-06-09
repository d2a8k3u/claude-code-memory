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

test('bare temporal words no longer trigger recall on their own', () => {
  // These previously matched bare /before/, /earlier/, /previously/, /yesterday/.
  assert.equal(isRecallStyle('Read the file before you edit it.'), false);
  assert.equal(isRecallStyle('Move this earlier in the function.'), false);
  assert.equal(isRecallStyle('Run the build, as previously configured.'), false);
});

test('past-tense question not about shared work is not recall', () => {
  // Previously any "?" + past-tense verb triggered recall.
  assert.equal(isRecallStyle('Did you read the README?'), false);
  assert.equal(isRecallStyle('Was the file saved correctly?'), false);
});

test('temporal word WITH a shared-work cue is still recall', () => {
  assert.ok(isRecallStyle('What did you change earlier?'));
  assert.ok(isRecallStyle('Did we already fix the auth bug?'));
});
