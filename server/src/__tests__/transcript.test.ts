import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTranscript, categorizeCommand } from '../cli/transcript.js';

function writeTranscript(dir: string, lines: object[]): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
}

describe('parseTranscript', () => {
  it('returns an empty summary for a missing transcript', () => {
    const s = parseTranscript('/no/such/file.jsonl', '/tmp');
    assert.equal(s.taskSummary, '');
    assert.deepEqual(s.toolsUsed, []);
    assert.equal(s.toolCallCount, 0);
    assert.deepEqual(s.bashCommands, []);
  });

  it('extracts task, tools, files, errors, and tech', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-tx-'));
    const path = writeTranscript(dir, [
      { role: 'user', content: 'Add retry logic to the fetch helper' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: join(dir, 'src/fetch.ts') } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: join(dir, 'src/fetch.ts') } },
          { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
      { role: 'tool', tool_use_id: 't3', content: 'Error: 1 test failed with exit code 1' },
    ]);

    const s = parseTranscript(path, dir);
    assert.equal(s.taskSummary, 'Add retry logic to the fetch helper');
    // Read is a read-only/noise tool -> excluded from toolsUsed; Edit + Bash are kept.
    assert.ok(s.toolsUsed.includes('Edit') && s.toolsUsed.includes('Bash'));
    assert.ok(!s.toolsUsed.includes('Read'));
    assert.deepEqual(s.filesModified, ['src/fetch.ts']);
    assert.deepEqual(s.filesRead, ['src/fetch.ts']);
    assert.ok(s.technologies.includes('typescript'), 'tech inferred from .ts extension');
    // The Bash command is correlated to its error result.
    assert.equal(s.bashCommands.length, 1);
    assert.equal(s.bashCommands[0].category, 'test');
    assert.equal(s.bashCommands[0].success, false);
    assert.equal(s.errorCount, 1);

    rmSync(dir, { recursive: true });
  });

  it('categorizes bash commands and marks clean runs successful', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-tx-'));
    const path = writeTranscript(dir, [
      { role: 'user', content: 'Build then lint' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run build' } },
          { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'eslint src' } },
        ],
      },
      { role: 'tool', tool_use_id: 'b1', content: 'Build complete.' },
      { role: 'tool', tool_use_id: 'b2', content: 'No problems found.' },
    ]);

    const s = parseTranscript(path, dir);
    assert.deepEqual(
      s.bashCommands.map((c) => c.category).sort(),
      ['build', 'lint'],
    );
    assert.ok(s.bashCommands.every((c) => c.success));
    assert.equal(s.errorCount, 0);

    rmSync(dir, { recursive: true });
  });

  it('excludes memory MCP tools from toolsUsed but counts memory ops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-tx-'));
    const path = writeTranscript(dir, [
      { role: 'user', content: 'Look something up' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'm1', name: 'mcp__claude-memory__memory_search', input: {} },
          { type: 'tool_use', id: 'm2', name: 'mcp__claude-memory__memory_store', input: {} },
        ],
      },
    ]);
    const s = parseTranscript(path, dir);
    assert.deepEqual(s.toolsUsed, [], 'memory MCP tools are noise');
    assert.equal(s.memorySearches, 1);
    assert.equal(s.memoryStores, 1);
    rmSync(dir, { recursive: true });
  });
});

describe('categorizeCommand', () => {
  it('maps representative commands to their category', () => {
    assert.equal(categorizeCommand('npm test'), 'test');
    assert.equal(categorizeCommand('eslint .'), 'lint');
    assert.equal(categorizeCommand('prettier --write .'), 'format');
    assert.equal(categorizeCommand('npm run build'), 'build');
    assert.equal(categorizeCommand('npm install'), 'install');
    assert.equal(categorizeCommand('git commit -m x'), 'git');
    assert.equal(categorizeCommand('echo hello'), 'other');
  });
});
