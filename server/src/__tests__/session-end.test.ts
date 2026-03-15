import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryDatabase } from '../database.js';
import {
  handleSessionEnd,
  parseListContent,
  computeSubstanceScore,
  SUBSTANCE_THRESHOLD,
  isTrivialCommand,
  parseWorkflowCommands,
  parseItemsWithCounts,
  formatItemsWithCounts,
  SEMANTIC_SINGLETON_CAP,
  deduplicateTaskDescriptions,
} from '../cli/session-end.js';
import { makeTempDb, cleanup } from './helpers.js';

function writeTranscript(dir: string, lines: object[]): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
}

describe('handleSessionEnd - unified episodic record', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('stores single episodic record with task summary', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Fix the login bug in the auth module' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    assert.ok(memories.length >= 1);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.ok(main, 'Should have a session-end tagged memory');
    assert.ok(main.content.includes('Fix the login bug in the auth module'));
    assert.ok(main.content.includes('Bash'));

    cleanup(db, dir);
  });

  it('merges files and errors into single episodic record', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Update the authentication module with new tests' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/auth.ts' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/src/utils.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
      { role: 'tool', content: 'Error: test failed with exit code 1' },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.ok(main, 'Should have a session-end tagged memory');
    assert.ok(main.content.includes('**Task:**'), 'Should contain task');
    assert.ok(main.content.includes('**Files modified:**'), 'Should contain files');
    assert.ok(main.content.includes('auth.ts'), 'Should list modified file');
    assert.ok(main.content.includes('**Errors:**'), 'Should contain errors');

    // No separate session-files or session-errors records
    const filesRecord = memories.find((m) => JSON.parse(m.tags).includes('session-files'));
    const errorsRecord = memories.find((m) => JSON.parse(m.tags).includes('session-errors'));
    assert.equal(filesRecord, undefined, 'Should not have separate files record');
    assert.equal(errorsRecord, undefined, 'Should not have separate errors record');

    cleanup(db, dir);
  });

  it('stores max 1 episodic record when all data present', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Full session with everything including changes' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/index.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
      { role: 'tool', content: 'Error: test failed with exit code 1' },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    assert.equal(memories.length, 1, `Expected exactly 1 episodic record, got ${memories.length}`);

    const tags = JSON.parse(memories[0].tags) as string[];
    assert.ok(tags.includes('session-end'));
    assert.ok(memories[0].content.includes('**Task:**'));
    assert.ok(memories[0].content.includes('**Files modified:**'));
    assert.ok(memories[0].content.includes('**Errors:**'));

    cleanup(db, dir);
  });

  it('episodic has no files or errors sections when no data', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Explain this code and how it works please' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo world' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo test' } },
        ],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.ok(main, 'Should have main episodic');
    assert.ok(!main.content.includes('**Files modified:**'), 'Should not have files section');
    assert.ok(!main.content.includes('**Errors:**'), 'Should not have errors section');

    cleanup(db, dir);
  });

  it('parses Claude Code wrapped transcript format', async () => {
    const transcriptPath = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: 'Refactor the auth module completely' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/src/auth.ts' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    assert.ok(memories.length >= 1, `Expected at least 1 memory, got ${memories.length}`);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.ok(main, 'Should have a session-end tagged memory');
    assert.ok(main.content.includes('Refactor the auth module completely'));
    assert.ok(main.content.includes('Bash'));

    cleanup(db, dir);
  });

  it('returns ok when no transcript content', async () => {
    const result = await handleSessionEnd(db, { cwd: dir });
    assert.deepEqual(result, { ok: true });
    assert.equal(db.countMemories(), 0);

    cleanup(db, dir);
  });
});

describe('parseListContent', () => {
  it('extracts comma-separated items after colon', () => {
    assert.deepEqual(parseListContent('Technology stack used: typescript, npm, node'), ['typescript', 'npm', 'node']);
  });

  it('trims whitespace from items', () => {
    assert.deepEqual(parseListContent('Active modules/directories:  server/src ,  server/test '), [
      'server/src',
      'server/test',
    ]);
  });

  it('returns empty array when no colon', () => {
    assert.deepEqual(parseListContent('no colon here'), []);
  });

  it('filters out empty strings', () => {
    assert.deepEqual(parseListContent('Tech: a,, b, ,c'), ['a', 'b', 'c']);
  });
});

describe('handleSessionEnd - substance gating', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('skips episodic when task summary is too short and no substance', async () => {
    const transcriptPath = writeTranscript(dir, [{ role: 'user', content: 'hi' }]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.equal(main, undefined, 'Should not create episodic for short task without substance');

    cleanup(db, dir);
  });

  it('skips episodic when task starts with [Request interrupted', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: '[Request interrupted by user for tool use]' },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.equal(main, undefined, 'Should not create episodic for interrupted request');

    cleanup(db, dir);
  });

  it('skips episodic for interrupted request even with high substance', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: '[Request interrupted by user for tool use]' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/a.ts' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/src/b.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.equal(main, undefined, 'Should skip episodic for interrupted request regardless of substance');

    cleanup(db, dir);
  });

  it('skips episodic when short task with single low-substance tool', async () => {
    // "Fix bug" = 7 chars (< 30), 1 Bash tool = substance score 3 (< 4 threshold)
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Fix bug' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.equal(main, undefined, 'Should skip episodic for short task with low substance');

    cleanup(db, dir);
  });

  it('skips episodic when task is 15-29 chars and low substance', async () => {
    // "Check the config" = 16 chars (>=15 old threshold, < 30 new threshold)
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Check the config' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat config.json' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.equal(main, undefined, 'Should skip episodic for medium-short task with low substance');

    cleanup(db, dir);
  });

  it('creates episodic when short task but high substance (many tools + files)', async () => {
    // "fix" = 3 chars but Edit + Write + Bash = 3 tools (6) + 2 files (6) + 1 bash (1) = score 13
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'fix' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/a.ts' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/src/b.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.ok(main, 'Should create episodic when substance is high despite short task');
    assert.ok(main.content.includes('**Files modified:**'), 'Should contain merged files section');

    cleanup(db, dir);
  });

  it('skips episodic for trivial session with only read-only tools', async () => {
    // Read is in READ_ONLY_TOOLS -> toolsUsed=[], toolCallCount=0
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'ok' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/src/a.ts' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.equal(main, undefined, 'Should skip episodic for trivial read-only session');

    cleanup(db, dir);
  });

  it('always creates episodic when task summary is 30+ chars', async () => {
    // Long task summary (>=30 chars) -> isMeaningless=false -> always created
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Explain how the authentication module works in this project' },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.ok(main, 'Should create episodic for long task even without tools');

    cleanup(db, dir);
  });
});

describe('computeSubstanceScore', () => {
  it('returns 0 for empty session', () => {
    assert.equal(
      computeSubstanceScore({
        toolsUsed: [],
        filesModified: [],
        errorCount: 0,
        memoryStores: 0,
        bashCommands: [],
      }),
      0,
    );
  });

  it('scores single bash tool at 3 (below threshold)', () => {
    const score = computeSubstanceScore({
      toolsUsed: ['Bash'],
      filesModified: [],
      errorCount: 0,
      memoryStores: 0,
      bashCommands: [{ command: 'npm test', success: true, category: 'test' }],
    });
    assert.equal(score, 3); // 1*2 + 0 + 0 + 0 + 1
    assert.ok(score < SUBSTANCE_THRESHOLD);
  });

  it('scores Edit + Bash + 1 file at 8 (above threshold)', () => {
    const score = computeSubstanceScore({
      toolsUsed: ['Edit', 'Bash'],
      filesModified: ['/src/a.ts'],
      errorCount: 0,
      memoryStores: 0,
      bashCommands: [{ command: 'npm test', success: true, category: 'test' }],
    });
    assert.equal(score, 8); // 2*2 + 1*3 + 0 + 0 + 1
    assert.ok(score >= SUBSTANCE_THRESHOLD);
  });

  it('caps non-trivial bash commands contribution at 5', () => {
    const score = computeSubstanceScore({
      toolsUsed: ['Bash'],
      filesModified: [],
      errorCount: 0,
      memoryStores: 0,
      bashCommands: Array.from({ length: 10 }, () => ({
        command: 'npm run build',
        success: true as const,
        category: 'build' as const,
      })),
    });
    assert.equal(score, 7); // 1*2 + 0 + 0 + 0 + min(10,5)
  });

  it('excludes trivial bash commands from score', () => {
    const score = computeSubstanceScore({
      toolsUsed: ['Bash'],
      filesModified: [],
      errorCount: 0,
      memoryStores: 0,
      bashCommands: [
        { command: 'echo hello', success: true, category: 'other' },
        { command: 'cat file.txt', success: true, category: 'other' },
        { command: 'ls -la', success: true, category: 'other' },
        { command: 'git status', success: true, category: 'git' },
        { command: 'npm test', success: true, category: 'test' },
      ],
    });
    assert.equal(score, 3); // 1*2 + 0 + 0 + 0 + min(1,5) — only npm test is non-trivial
  });

  it('includes error bonus', () => {
    const score = computeSubstanceScore({
      toolsUsed: ['Bash'],
      filesModified: [],
      errorCount: 3,
      memoryStores: 0,
      bashCommands: [{ command: 'npm test', success: false, category: 'test' }],
    });
    assert.equal(score, 5); // 1*2 + 0 + 2 + 0 + 1
    assert.ok(score >= SUBSTANCE_THRESHOLD);
  });

  it('includes memory stores', () => {
    const score = computeSubstanceScore({
      toolsUsed: ['Bash'],
      filesModified: [],
      errorCount: 0,
      memoryStores: 3,
      bashCommands: [{ command: 'npm test', success: true, category: 'test' }],
    });
    assert.equal(score, 6); // 1*2 + 0 + 0 + 3 + 1
  });
});

describe('handleSessionEnd - semantic tech-stack creates fallback record', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('creates semantic tech-stack record via fallback when embeddings unavailable', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Build the typescript project with tests' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npx tsc && npm test' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const semantics = db.listMemories('semantic', 10, 0);
    const techStack = semantics.find((m) => JSON.parse(m.tags).includes('tech-stack'));
    assert.ok(techStack, 'Should create tech-stack semantic record');
    assert.ok(techStack.content.includes('Technology stack used:'));

    cleanup(db, dir);
  });

  it('does not include semantic records in the batch flow', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Build the typescript project with tests' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npx tsc && npm test' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    // Episodic records should exist, semantic handled separately
    const episodics = db.listMemories('episodic', 10, 0);
    assert.ok(episodics.length >= 1);

    const semantics = db.listMemories('semantic', 10, 0);
    // Tech-stack should be created via mergeOrCreateSemantic, not batch
    if (semantics.length > 0) {
      const techStack = semantics.find((m) => JSON.parse(m.tags).includes('tech-stack'));
      assert.ok(techStack, 'Semantic should be tech-stack');
    }

    cleanup(db, dir);
  });
});

describe('isTrivialCommand', () => {
  it('identifies inspection commands as trivial', () => {
    assert.equal(isTrivialCommand('echo hello'), true);
    assert.equal(isTrivialCommand('cat file.txt'), true);
    assert.equal(isTrivialCommand('ls -la'), true);
    assert.equal(isTrivialCommand('pwd'), true);
    assert.equal(isTrivialCommand('git status'), true);
    assert.equal(isTrivialCommand('git log --oneline'), true);
    assert.equal(isTrivialCommand('git diff HEAD'), true);
    assert.equal(isTrivialCommand('head -n 10 file.txt'), true);
    assert.equal(isTrivialCommand('tail -f log.txt'), true);
    assert.equal(isTrivialCommand('which node'), true);
  });

  it('passes workflow commands as non-trivial', () => {
    assert.equal(isTrivialCommand('npm test'), false);
    assert.equal(isTrivialCommand('npm run build'), false);
    assert.equal(isTrivialCommand('tsc --noEmit'), false);
    assert.equal(isTrivialCommand('npx eslint .'), false);
    assert.equal(isTrivialCommand('docker build .'), false);
    assert.equal(isTrivialCommand('npm install express'), false);
  });

  it('handles leading whitespace', () => {
    assert.equal(isTrivialCommand('  echo test'), true);
    assert.equal(isTrivialCommand('  npm test'), false);
  });
});

describe('parseWorkflowCommands', () => {
  it('extracts commands from workflow content', () => {
    assert.deepEqual(parseWorkflowCommands('Build workflow: tsc && npm run build'), ['tsc', 'npm run build']);
  });

  it('handles single command', () => {
    assert.deepEqual(parseWorkflowCommands('Test workflow: npm test'), ['npm test']);
  });

  it('returns empty for content without colon', () => {
    assert.deepEqual(parseWorkflowCommands('no colon here'), []);
  });

  it('trims whitespace from commands', () => {
    assert.deepEqual(parseWorkflowCommands('Build workflow:  tsc  &&  npm run build  '), ['tsc', 'npm run build']);
  });
});

describe('handleSessionEnd - procedural creation', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  // Helper: creates transcript lines with proper tool_use ids and tool results
  function bashToolUse(id: string, command: string) {
    return { type: 'tool_use', id, name: 'Bash', input: { command } };
  }
  function toolResult(toolUseId: string, content = 'ok') {
    return { role: 'tool', tool_use_id: toolUseId, content };
  }

  it('skips procedural when category has fewer than 3 commands', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Build the project and run type checking' },
      { role: 'assistant', content: [bashToolUse('b1', 'tsc'), bashToolUse('b2', 'npm run build')] },
      toolResult('b1'),
      toolResult('b2'),
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const procedurals = db.listMemories('procedural', 10, 0);
    assert.equal(procedurals.length, 0, 'Should not create procedural with only 2 commands');

    cleanup(db, dir);
  });

  it('creates procedural when category has 3+ non-trivial commands', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Build the project with all checks and verification' },
      {
        role: 'assistant',
        content: [
          bashToolUse('b1', 'tsc'),
          bashToolUse('b2', 'npm run build'),
          bashToolUse('b3', 'esbuild src/index.ts'),
        ],
      },
      toolResult('b1'),
      toolResult('b2'),
      toolResult('b3'),
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const procedurals = db.listMemories('procedural', 10, 0);
    assert.equal(procedurals.length, 1, 'Should create procedural with 3 build commands');
    assert.ok(procedurals[0].content.includes('tsc'));
    assert.ok(procedurals[0].content.includes('npm run build'));
    assert.ok(procedurals[0].content.includes('esbuild'));

    cleanup(db, dir);
  });

  it('filters trivial commands from procedural creation', async () => {
    // echo is trivial, so only 2 non-trivial build commands remain -> no procedural
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Build the project with some echo commands' },
      {
        role: 'assistant',
        content: [
          bashToolUse('b1', 'echo "starting build"'),
          bashToolUse('b2', 'tsc'),
          bashToolUse('b3', 'npm run build'),
        ],
      },
      toolResult('b1'),
      toolResult('b2'),
      toolResult('b3'),
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const procedurals = db.listMemories('procedural', 10, 0);
    assert.equal(procedurals.length, 0, 'Should not create procedural when trivial commands filtered leaves < 3');

    cleanup(db, dir);
  });

  it('skips update when incoming commands are subset of existing', async () => {
    const { makeMemoryRecord: mkRecord } = await import('../cli/shared.js');
    const existing = mkRecord(
      'procedural',
      'Build workflow: tsc && npm run build && esbuild src/index.ts',
      ['auto-procedural', 'build'],
      {
        title: 'Build workflow',
        context: 'session-end auto-save',
      },
    );
    db.insertMemory(existing);
    const originalContent = existing.content;

    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Run a quick build to check the project compiles' },
      {
        role: 'assistant',
        content: [
          bashToolUse('b1', 'tsc'),
          bashToolUse('b2', 'npm run build'),
          bashToolUse('b3', 'esbuild src/index.ts'),
        ],
      },
      toolResult('b1'),
      toolResult('b2'),
      toolResult('b3'),
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const procedurals = db.listMemories('procedural', 10, 0);
    assert.equal(procedurals.length, 1);
    assert.equal(procedurals[0].content, originalContent, 'Should not update when commands are a subset');

    cleanup(db, dir);
  });

  it('merges new commands into existing procedural', async () => {
    const { makeMemoryRecord: mkRecord } = await import('../cli/shared.js');
    const existing = mkRecord('procedural', 'Build workflow: tsc && npm run build', ['auto-procedural', 'build'], {
      title: 'Build workflow',
      context: 'session-end auto-save',
    });
    db.insertMemory(existing);

    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Build the project with extra steps for release' },
      {
        role: 'assistant',
        content: [
          bashToolUse('b1', 'npm run build'),
          bashToolUse('b2', 'esbuild src/index.ts'),
          bashToolUse('b3', 'webpack --mode production'),
        ],
      },
      toolResult('b1'),
      toolResult('b2'),
      toolResult('b3'),
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const procedurals = db.listMemories('procedural', 10, 0);
    assert.equal(procedurals.length, 1);
    assert.ok(procedurals[0].content.includes('tsc'), 'Should keep original command');
    assert.ok(procedurals[0].content.includes('npm run build'), 'Should keep shared command');
    assert.ok(procedurals[0].content.includes('esbuild'), 'Should add new command');
    assert.ok(procedurals[0].content.includes('webpack'), 'Should add new command');

    cleanup(db, dir);
  });
});

describe('parseItemsWithCounts', () => {
  it('parses new format with counts', () => {
    assert.deepEqual(parseItemsWithCounts('Tech: typescript(5), npm(3)'), [
      { name: 'typescript', count: 5 },
      { name: 'npm', count: 3 },
    ]);
  });

  it('handles old format without counts (defaults to 1)', () => {
    assert.deepEqual(parseItemsWithCounts('Tech: typescript, npm'), [
      { name: 'typescript', count: 1 },
      { name: 'npm', count: 1 },
    ]);
  });

  it('handles mixed format', () => {
    assert.deepEqual(parseItemsWithCounts('Tech: typescript(3), npm'), [
      { name: 'typescript', count: 3 },
      { name: 'npm', count: 1 },
    ]);
  });

  it('returns empty for content without colon', () => {
    assert.deepEqual(parseItemsWithCounts('no colon here'), []);
  });
});

describe('formatItemsWithCounts', () => {
  it('produces correct output', () => {
    assert.equal(
      formatItemsWithCounts([
        { name: 'typescript', count: 5 },
        { name: 'npm', count: 3 },
      ]),
      'typescript(5), npm(3)',
    );
  });

  it('handles single item', () => {
    assert.equal(formatItemsWithCounts([{ name: 'node', count: 1 }]), 'node(1)');
  });
});

describe('handleSessionEnd - semantic singleton merge', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('creates tech-stack with frequency counts on first session', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Build the typescript project with tests' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npx tsc && npm test' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const semantics = db.listMemories('semantic', 10, 0);
    const techStack = semantics.find((m) => JSON.parse(m.tags).includes('tech-stack'));
    assert.ok(techStack, 'Should create tech-stack semantic record');
    assert.ok(techStack.content.includes('Technology stack used:'));
    // New format includes counts
    assert.ok(techStack.content.includes('(1)'), 'Should include frequency count');

    cleanup(db, dir);
  });

  it('increments frequency on re-detection', async () => {
    // Pre-seed with existing tech-stack in new format
    const { makeMemoryRecord: mkRecord } = await import('../cli/shared.js');
    const existing = mkRecord(
      'semantic',
      'Technology stack used: typescript(2), npm(1)',
      ['auto-semantic', 'tech-stack'],
      {
        title: 'Technology stack',
        context: 'session-end auto-save',
      },
    );
    db.insertMemory(existing);

    // Session detects typescript and node (new item)
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Build the typescript project and add node server' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'tsc' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'node server.js' } },
        ],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const semantics = db.listMemories('semantic', 10, 0);
    const techStack = semantics.find((m) => JSON.parse(m.tags).includes('tech-stack'));
    assert.ok(techStack);
    // typescript should be incremented, node added, npm kept
    assert.ok(techStack.content.includes('typescript(3)'), 'typescript should be incremented');
    assert.ok(techStack.content.includes('npm(1)'), 'npm should be kept');
    assert.ok(techStack.content.includes('node(1)'), 'node should be added');

    cleanup(db, dir);
  });

  it('caps items at SEMANTIC_SINGLETON_CAP', async () => {
    // Pre-seed with max items: first item has high count, rest have count=1
    const { makeMemoryRecord: mkRecord } = await import('../cli/shared.js');
    const items = [
      `important(10)`,
      ...Array.from({ length: SEMANTIC_SINGLETON_CAP - 1 }, (_, i) => `tech${i}(1)`),
    ].join(', ');
    const existing = mkRecord('semantic', `Technology stack used: ${items}`, ['auto-semantic', 'tech-stack'], {
      title: 'Technology stack',
      context: 'session-end auto-save',
    });
    db.insertMemory(existing);

    // Session detects a new tech not in the list
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Setup the new rust compiler and cargo build system' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cargo build' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const semantics = db.listMemories('semantic', 10, 0);
    const techStack = semantics.find((m) => JSON.parse(m.tags).includes('tech-stack'));
    assert.ok(techStack);

    const parsed = parseItemsWithCounts(techStack.content);
    assert.equal(parsed.length, SEMANTIC_SINGLETON_CAP, `Should be capped at ${SEMANTIC_SINGLETON_CAP}`);
    // High-count item should survive
    assert.ok(techStack.content.includes('important(10)'), 'High-frequency item should be kept');
    // Total is still capped: 15 existing + 1 new = 16, but capped to 15, so one tech(1) item was dropped
    const totalItems = SEMANTIC_SINGLETON_CAP + 1; // 15 existing + 1 new (rust)
    assert.ok(totalItems > SEMANTIC_SINGLETON_CAP, 'Test setup should exceed cap');

    cleanup(db, dir);
  });

  it('skips update when all incoming items already exist', async () => {
    const { makeMemoryRecord: mkRecord } = await import('../cli/shared.js');
    const existing = mkRecord(
      'semantic',
      'Technology stack used: typescript(3), npm(2)',
      ['auto-semantic', 'tech-stack'],
      {
        title: 'Technology stack',
        context: 'session-end auto-save',
      },
    );
    db.insertMemory(existing);
    const originalContent = existing.content;

    // Session detects only typescript (already in list)
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Compile the typescript project for production' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'tsc' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const semantics = db.listMemories('semantic', 10, 0);
    const techStack = semantics.find((m) => JSON.parse(m.tags).includes('tech-stack'));
    assert.ok(techStack);
    assert.equal(techStack.content, originalContent, 'Should not update when no new items');

    cleanup(db, dir);
  });

  it('handles backward compatibility with old format', async () => {
    // Pre-seed with old format (no counts)
    const { makeMemoryRecord: mkRecord } = await import('../cli/shared.js');
    const existing = mkRecord('semantic', 'Technology stack used: typescript, npm', ['auto-semantic', 'tech-stack'], {
      title: 'Technology stack',
      context: 'session-end auto-save',
    });
    db.insertMemory(existing);

    // Session detects node (new item)
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Start the node server and run build process' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node server.js' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const semantics = db.listMemories('semantic', 10, 0);
    const techStack = semantics.find((m) => JSON.parse(m.tags).includes('tech-stack'));
    assert.ok(techStack);
    // Old items should be parsed as count=1, node incremented to 1
    assert.ok(techStack.content.includes('node('), 'New item should have count format');
    assert.ok(techStack.content.includes('typescript('), 'Old items should be migrated to count format');

    cleanup(db, dir);
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

describe('handleSessionEnd - noise tool filtering', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('excludes memory MCP tools from episodic tools list', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Search memory and fix the authentication module bug' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'mcp__claude-memory__memory_search', input: { query: 'auth' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/src/auth.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.ok(main, 'Should create episodic record');
    assert.ok(main.content.includes('Bash'), 'Should include Bash in tools');
    assert.ok(main.content.includes('Edit'), 'Should include Edit in tools');
    assert.ok(!main.content.includes('mcp__claude-memory'), 'Should exclude memory MCP tools');

    cleanup(db, dir);
  });
});
