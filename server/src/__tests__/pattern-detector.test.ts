import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractTaskFromEpisodic, deduplicateTaskDescriptions } from '../cli/pattern-detector.js';

describe('extractTaskFromEpisodic', () => {
  it('extracts task from **Task:** pattern', () => {
    const content = '**Task:** Fix authentication bug\n**Files modified:** auth.ts';
    assert.equal(extractTaskFromEpisodic(content), 'Fix authentication bug');
  });

  it('falls back to first 100 chars when no task pattern', () => {
    const content = 'Some episodic content without a task marker that is fairly long and detailed';
    assert.equal(extractTaskFromEpisodic(content), content.slice(0, 100));
  });

  it('handles task at end of content without newline', () => {
    const content = '**Task:** Deploy the new version';
    assert.equal(extractTaskFromEpisodic(content), 'Deploy the new version');
  });

  it('trims whitespace from extracted task', () => {
    const content = '**Task:**   Refactor database module  \n**Tools:** Read';
    assert.equal(extractTaskFromEpisodic(content), 'Refactor database module');
  });
});

describe('deduplicateTaskDescriptions', () => {
  it('removes exact duplicates preserving first occurrence', () => {
    assert.deepEqual(deduplicateTaskDescriptions(['Fix auth bug', 'Fix auth bug', 'Add tests']), [
      'Fix auth bug',
      'Add tests',
    ]);
  });

  it('removes case-insensitive duplicates preserving original casing', () => {
    assert.deepEqual(deduplicateTaskDescriptions(['Fix Auth Bug', 'fix auth bug', 'Add Tests']), [
      'Fix Auth Bug',
      'Add Tests',
    ]);
  });

  it('normalizes whitespace for comparison', () => {
    assert.deepEqual(deduplicateTaskDescriptions(['Fix  auth   bug', 'Fix auth bug']), ['Fix  auth   bug']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(deduplicateTaskDescriptions([]), []);
  });

  it('preserves all items when no duplicates exist', () => {
    const tasks = ['Fix auth', 'Add tests', 'Update docs'];
    assert.deepEqual(deduplicateTaskDescriptions(tasks), tasks);
  });
});
