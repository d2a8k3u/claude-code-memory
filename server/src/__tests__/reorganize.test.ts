import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleReorganize } from '../cli/reorganize.js';
import { makeTempDb, cleanup, makeMemoryRow } from './helpers.js';
import { safeParseTags } from '../merge-utils.js';

describe('handleReorganize', () => {
  it('deduplicates accumulative tech-stack records into one merged record', async () => {
    const { db, dir } = makeTempDb();
    db.insertMemory(
      makeMemoryRow({
        id: 'ts1',
        type: 'semantic',
        title: 'Tech stack',
        content: 'Technology stack: typescript(2), npm(1)',
        tags: JSON.stringify(['tech-stack']),
      }),
    );
    db.insertMemory(
      makeMemoryRow({
        id: 'ts2',
        type: 'semantic',
        title: 'Tech stack',
        content: 'Technology stack: python(1)',
        tags: JSON.stringify(['tech-stack']),
      }),
    );

    await handleReorganize(db, {});

    const techStack = db
      .listMemories('semantic', 50, 0)
      .filter((m) => safeParseTags(m.tags).includes('tech-stack'));
    assert.equal(techStack.length, 1, 'accumulative records merged into one');
    assert.match(techStack[0].content, /typescript/);
    assert.match(techStack[0].content, /python/);
    cleanup(db, dir);
  });

  it('splits a large multi-topic memory and deletes the monolith', async () => {
    const { db, dir } = makeTempDb();
    const big =
      '## Database layer\n' +
      'The database uses SQLite with WAL mode and foreign keys enabled. '.repeat(6) +
      '\n\n## Embeddings\n' +
      'Embeddings use a local MiniLM model with 384 dimensions and cosine distance. '.repeat(6);
    db.insertMemory(makeMemoryRow({ id: 'big', type: 'semantic', title: 'Architecture', content: big }));

    const before = db.countMemories();
    await handleReorganize(db, {});
    const after = db.countMemories();

    assert.ok(after > before, 'the monolithic memory was decomposed into more pieces');
    assert.equal(db.getMemoryByIdRaw('big'), null, 'original monolithic memory deleted');
    cleanup(db, dir);
  });
});
