import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyText } from '../cli/classifier.js';

test('classifies user-correction text as pattern', () => {
  const r = classifyText("Don't use maxLength on Zod schemas — quality through writing, not limits.");
  assert.equal(r.type, 'pattern');
  assert.ok(r.confidence >= 0.5);
});

test('classifies tech-stack description as semantic', () => {
  const r = classifyText('The project uses TypeScript, Vite, and Vue 3.');
  assert.equal(r.type, 'semantic');
});

test('classifies workflow description as procedural', () => {
  const r = classifyText('To run tests: npm run build && npm test.');
  assert.equal(r.type, 'procedural');
});

test('classifies narrative turn as episodic', () => {
  const r = classifyText('Refactored the transcript parser and fixed the noise filter.');
  assert.equal(r.type, 'episodic');
});

test('returns unknown with low confidence for empty text', () => {
  const r = classifyText('');
  assert.equal(r.type, 'unknown');
  assert.ok(r.confidence <= 0.1);
});
