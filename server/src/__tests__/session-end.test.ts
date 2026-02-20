import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryDatabase } from '../database.js';
import { handleSessionEnd } from '../cli/session-end.js';
import { makeTempDb, cleanup } from './helpers.js';

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
