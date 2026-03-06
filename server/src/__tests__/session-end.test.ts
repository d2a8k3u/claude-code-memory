import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryDatabase } from '../database.js';
import { handleSessionEnd, parseListContent } from '../cli/session-end.js';
import { makeTempDb, cleanup, makeEmbedding } from './helpers.js';
import { embeddingToBuffer } from '../embeddings.js';

function writeTranscript(dir: string, lines: object[]): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
}

describe('handleSessionEnd - structured records', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('stores main episodic record with task summary', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Fix the login bug' },
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
    assert.ok(main.content.includes('Fix the login bug'));
    assert.ok(main.content.includes('Bash'));

    cleanup(db, dir);
  });

  it('stores separate files-modified record when files exist', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Update auth module' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/auth.ts' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/src/utils.ts' } },
        ],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const filesRecord = memories.find((m) => JSON.parse(m.tags).includes('session-files'));
    assert.ok(filesRecord, 'Should have a session-files tagged memory');
    assert.ok(filesRecord.content.includes('Files modified'));
    assert.ok(filesRecord.content.includes('auth.ts'));

    cleanup(db, dir);
  });

  it('stores separate errors record when errors > 0', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Run deployment' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run deploy' } }],
      },
      { role: 'tool', content: 'Error: ENOENT file not found' },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const errorsRecord = memories.find((m) => JSON.parse(m.tags).includes('session-errors'));
    assert.ok(errorsRecord, 'Should have a session-errors tagged memory');
    assert.ok(errorsRecord.content.includes('Errors encountered'));
    assert.ok(errorsRecord.content.includes('1 errors'));
    assert.ok(errorsRecord.content.includes('Run deployment'));

    cleanup(db, dir);
  });

  it('skips files and errors records when no data', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Explain this code' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } }],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const filesRecord = memories.find((m) => JSON.parse(m.tags).includes('session-files'));
    const errorsRecord = memories.find((m) => JSON.parse(m.tags).includes('session-errors'));
    assert.equal(filesRecord, undefined, 'Should not have files record');
    assert.equal(errorsRecord, undefined, 'Should not have errors record');

    cleanup(db, dir);
  });

  it('parses Claude Code wrapped transcript format', async () => {
    const transcriptPath = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: 'Refactor the auth module' } },
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
    assert.ok(main.content.includes('Refactor the auth module'));
    assert.ok(main.content.includes('Bash'));

    cleanup(db, dir);
  });

  it('returns ok when no transcript content', async () => {
    const result = await handleSessionEnd(db, { cwd: dir });
    assert.deepEqual(result, { ok: true });
    assert.equal(db.countMemories(), 0);

    cleanup(db, dir);
  });

  it('stores max 3 records when all data present', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'Full session with everything' },
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
    assert.ok(memories.length <= 3, `Expected at most 3 records, got ${memories.length}`);
    assert.ok(memories.length >= 2, `Expected at least 2 records, got ${memories.length}`);

    const tags = memories.map((m) => JSON.parse(m.tags) as string[]);
    assert.ok(tags.some((t) => t.includes('session-end')));
    assert.ok(tags.some((t) => t.includes('session-files')));
    assert.ok(tags.some((t) => t.includes('session-errors')));

    cleanup(db, dir);
  });
});

describe('parseListContent', () => {
  it('extracts comma-separated items after colon', () => {
    assert.deepEqual(
      parseListContent('Technology stack used: typescript, npm, node'),
      ['typescript', 'npm', 'node'],
    );
  });

  it('trims whitespace from items', () => {
    assert.deepEqual(
      parseListContent('Active modules/directories:  server/src ,  server/test '),
      ['server/src', 'server/test'],
    );
  });

  it('returns empty array when no colon', () => {
    assert.deepEqual(parseListContent('no colon here'), []);
  });

  it('filters out empty strings', () => {
    assert.deepEqual(
      parseListContent('Tech: a,, b, ,c'),
      ['a', 'b', 'c'],
    );
  });
});

describe('handleSessionEnd - meaningless episodic filter', () => {
  let db: MemoryDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTempDb());
  });

  it('skips main episodic when task summary is too short and no tools', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'hi' },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.equal(main, undefined, 'Should not create main episodic for short task');

    cleanup(db, dir);
  });

  it('skips main episodic when task starts with [Request interrupted', async () => {
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: '[Request interrupted by user for tool use]' },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const main = memories.find((m) => JSON.parse(m.tags).includes('session-end'));
    assert.equal(main, undefined, 'Should not create episodic for interrupted request');

    cleanup(db, dir);
  });

  it('keeps episodic when short task but has tools', async () => {
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
    assert.ok(main, 'Should keep episodic when tools were used');

    cleanup(db, dir);
  });

  it('still creates files-modified even when main episodic is skipped', async () => {
    // Short task summary but with file modifications
    const transcriptPath = writeTranscript(dir, [
      { role: 'user', content: 'ok' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/a.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/b.ts' } },
        ],
      },
    ]);

    await handleSessionEnd(db, { transcript_path: transcriptPath, cwd: dir });

    const memories = db.listMemories('episodic', 10, 0);
    const filesRecord = memories.find((m) => JSON.parse(m.tags).includes('session-files'));
    assert.ok(filesRecord, 'Should still create files-modified record');

    cleanup(db, dir);
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
