import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTaskFromEpisodic,
  deduplicateTaskDescriptions,
  stripEpisodicBoilerplate,
  computeTopicOverlap,
} from '../cli/pattern-detector.js';
import { derivePatternTitle } from '../cli/shared.js';

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

describe('stripEpisodicBoilerplate', () => {
  it('strips all structural markers', () => {
    const content =
      '**Task:** Fix the auth bug\n**Tools:** Edit, Bash\n**Memory ops:** 2 searches, 1 stores\n**Files modified:** src/auth.ts';
    const stripped = stripEpisodicBoilerplate(content);
    assert.equal(stripped, 'Fix the auth bug');
  });

  it('returns empty for boilerplate-only content', () => {
    const content = '**Tools:** Bash\n**Files modified:** index.ts';
    assert.equal(stripEpisodicBoilerplate(content), '');
  });

  it('preserves non-boilerplate text', () => {
    const content = 'Some custom content\n**Tools:** Bash\nMore content';
    const stripped = stripEpisodicBoilerplate(content);
    assert.ok(stripped.includes('Some custom content'));
    assert.ok(stripped.includes('More content'));
    assert.ok(!stripped.includes('**Tools:**'));
  });
});

describe('computeTopicOverlap', () => {
  it('returns high overlap for topically similar tasks', () => {
    const tasks = [
      'Fix authentication bug in login module',
      'Fix authentication error in login page',
      'Debug authentication issue in login flow',
    ];
    const overlap = computeTopicOverlap(tasks);
    assert.ok(overlap > 0.2, `Expected > 0.2 but got ${overlap}`);
  });

  it('returns low overlap for unrelated tasks', () => {
    const tasks = [
      'Render the visualization page for the plugin',
      'Update the readme and prepare a new release',
      'Consolidate memory-cleanup and memory-reorganize skills',
      'Analyze the plugin and propose improvements',
    ];
    const overlap = computeTopicOverlap(tasks);
    assert.ok(overlap < 0.15, `Expected < 0.15 but got ${overlap}`);
  });

  it('returns 0 for single task', () => {
    assert.equal(computeTopicOverlap(['Fix auth bug']), 0);
  });

  it('returns 0 for empty input', () => {
    assert.equal(computeTopicOverlap([]), 0);
  });
});

describe('derivePatternTitle', () => {
  it('extracts common words from English texts', () => {
    const texts = [
      'Fix authentication bug in login',
      'Fix authentication error in signup',
      'Fix authentication issue in reset',
    ];
    const title = derivePatternTitle(texts);
    assert.ok(title.toLowerCase().includes('fix'));
    assert.ok(title.toLowerCase().includes('authentication'));
    assert.notEqual(title, 'Recurring activity pattern');
  });

  it('falls back to generic title when no common words', () => {
    const texts = ['Fix auth bug', 'Update readme docs', 'Deploy new version'];
    const title = derivePatternTitle(texts);
    assert.equal(title, 'Recurring activity pattern');
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
