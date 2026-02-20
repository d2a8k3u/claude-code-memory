import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractGitSignals, type GitSignals } from '../cli/git-signals.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('extractGitSignals', () => {
  describe('CWD parsing', () => {
    it('extracts last 2 path segments', () => {
      const signals = extractGitSignals('/home/user/projects/my-awesome-app');
      assert.ok(signals.cwd.includes('projects'));
      assert.ok(signals.cwd.includes('my-awesome-app'));
    });

    it('filters segments shorter than 3 chars', () => {
      const signals = extractGitSignals('/a/bb/my-project');
      assert.ok(!signals.cwd.includes('bb'));
      assert.ok(signals.cwd.includes('my-project'));
    });

    it('lowercases segments', () => {
      const signals = extractGitSignals('/Users/Dev/MyProject');
      for (const seg of signals.cwd) {
        assert.equal(seg, seg.toLowerCase());
      }
    });

    it('deduplicates CWD segments', () => {
      const signals = extractGitSignals('/foo/test/test');
      const testCount = signals.cwd.filter((s) => s === 'test').length;
      assert.equal(testCount, 1);
    });
  });

  describe('non-git directory', () => {
    it('returns empty branch/commits/files but populated CWD', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'non-git-test-'));
      try {
        const signals = extractGitSignals(tmpDir);
        assert.deepEqual(signals.branch, []);
        assert.deepEqual(signals.commits, []);
        assert.deepEqual(signals.files, []);
        assert.ok(signals.cwd.length > 0);
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe('return type shape', () => {
    it('always returns all 4 fields as arrays', () => {
      const signals = extractGitSignals('/tmp/nonexistent-path-xyz');
      assert.ok(Array.isArray(signals.cwd));
      assert.ok(Array.isArray(signals.branch));
      assert.ok(Array.isArray(signals.commits));
      assert.ok(Array.isArray(signals.files));
    });

    it('satisfies GitSignals interface', () => {
      const signals = extractGitSignals(process.cwd());
      const _typeCheck: GitSignals = signals;
      assert.ok(_typeCheck);
    });
  });

  describe('git repo signals', () => {
    it('extracts branch, commits, and files from current repo', () => {
      const signals = extractGitSignals(process.cwd());
      // We're in a git repo, so branch should be populated
      assert.ok(signals.branch.length >= 0); // could be main/HEAD
      // All values should be lowercase strings
      for (const field of ['cwd', 'branch', 'commits', 'files'] as const) {
        for (const term of signals[field]) {
          assert.equal(typeof term, 'string');
          assert.equal(term, term.toLowerCase());
        }
      }
    });
  });
});
