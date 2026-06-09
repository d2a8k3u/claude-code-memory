import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isTitleVersionStale,
  supersedesByVersion,
  readProjectIdentity,
  suppressStaleProjectMemories,
} from '../cli/staleness.js';
import { makeTempDb, makeEmbedding, cleanup, makeMemoryRow } from './helpers.js';
import { embeddingToBuffer } from '../embeddings.js';

const PROJECT = { name: 'claude-memory', version: '1.2.0' };

describe('staleness - isTitleVersionStale', () => {
  it('flags an older project-version self-description', () => {
    assert.equal(isTitleVersionStale('Claude Memory Plugin - Feature Inventory (v0.2.0)', PROJECT), true);
  });

  it('does not flag a title at the current version', () => {
    assert.equal(isTitleVersionStale('Claude Memory Plugin - Feature Inventory (v1.2.0)', PROJECT), false);
  });

  it('does not flag a title at a newer version', () => {
    assert.equal(isTitleVersionStale('claude-memory roadmap for v2.0.0', PROJECT), false);
  });

  it('does not flag a title that omits the project name', () => {
    assert.equal(isTitleVersionStale('Some other library v0.1.0 notes', PROJECT), false);
  });

  it('does not flag a title with no version token', () => {
    assert.equal(isTitleVersionStale('claude-memory architecture overview', PROJECT), false);
  });
});

describe('staleness - supersedesByVersion', () => {
  it('newer title supersedes older', () => {
    assert.equal(supersedesByVersion('Feature Inventory (v1.2.0)', 'Feature Inventory (v0.2.0)'), true);
  });
  it('older title does not supersede newer', () => {
    assert.equal(supersedesByVersion('Feature Inventory (v0.2.0)', 'Feature Inventory (v1.2.0)'), false);
  });
  it('returns false when either title lacks a version', () => {
    assert.equal(supersedesByVersion('Feature Inventory', 'Feature Inventory (v0.2.0)'), false);
  });
});

describe('staleness - readProjectIdentity', () => {
  it('reads name + version from package.json in cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-proj-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'myapp', version: '2.1.0' }));
    const id = readProjectIdentity(dir);
    assert.deepEqual(id, { name: 'myapp', version: '2.1.0' });
    rmSync(dir, { recursive: true });
  });

  it('returns null when no version file is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-proj-'));
    assert.equal(readProjectIdentity(dir), null);
    rmSync(dir, { recursive: true });
  });
});

describe('staleness - suppressStaleProjectMemories', () => {
  it('supersedes stale self-version memories and excludes them from search', () => {
    const { db, dir } = makeTempDb();
    const projDir = mkdtempSync(join(tmpdir(), 'claude-mem-proj-'));
    writeFileSync(join(projDir, 'package.json'), JSON.stringify(PROJECT));

    db.insertMemory({
      ...makeMemoryRow({
        id: 'stale',
        type: 'semantic',
        title: 'Claude Memory Plugin - Feature Inventory (v0.2.0)',
        content: 'Feature inventory for claude-memory v0.2.0: production ready.',
      }),
      embedding: embeddingToBuffer(makeEmbedding(1)),
    });
    db.insertMemory({
      ...makeMemoryRow({
        id: 'current',
        type: 'semantic',
        title: 'claude-memory architecture overview',
        content: 'How the plugin is structured.',
      }),
      embedding: embeddingToBuffer(makeEmbedding(2)),
    });

    const count = suppressStaleProjectMemories(db, projDir);
    assert.equal(count, 1, 'one stale memory superseded');

    const stale = db.getMemoryByIdRaw('stale')!;
    assert.ok(stale.superseded_by, 'stale memory marked superseded');
    const current = db.getMemoryByIdRaw('current')!;
    assert.equal(current.superseded_by, null, 'current memory untouched');

    // Excluded from search even though it matches strongly on text.
    const results = db.hybridSearchMemories('feature inventory claude-memory', makeEmbedding(1), 10, {
      topicThreshold: 0,
    });
    assert.ok(!results.some((r) => r.id === 'stale'), 'superseded memory not returned by search');

    rmSync(projDir, { recursive: true });
    cleanup(db, dir);
  });

  it('returns 0 when the project version cannot be read', () => {
    const { db, dir } = makeTempDb();
    const emptyDir = mkdtempSync(join(tmpdir(), 'claude-mem-proj-'));
    db.insertMemory(
      makeMemoryRow({ id: 'x', type: 'semantic', title: 'Feature Inventory (v0.2.0) claude-memory' }),
    );
    assert.equal(suppressStaleProjectMemories(db, emptyDir), 0);
    rmSync(emptyDir, { recursive: true });
    cleanup(db, dir);
  });
});
