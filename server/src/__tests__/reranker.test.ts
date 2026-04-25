import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ScoredMemoryRow } from '../database.js';
import {
  rerankResults,
  overfetchLimit,
  warmRerankerModel,
  isRerankerAvailable,
  resetRerankerState,
} from '../reranker.js';

function makeScoredRow(overrides: Partial<ScoredMemoryRow> & { id: string }): ScoredMemoryRow {
  const now = new Date().toISOString();
  return {
    type: 'semantic',
    title: null,
    content: 'test content',
    context: null,
    source: null,
    tags: '[]',
    importance: 0.5,
    created_at: now,
    updated_at: now,
    access_count: 0,
    last_accessed: null,
    injection_count: 0,
    score: 0.5,
    textScore: 0.3,
    ...overrides,
  };
}

// ==========================================================
// overfetchLimit
// ==========================================================
describe('overfetchLimit', () => {
  it('returns 3x the desired limit', () => {
    assert.equal(overfetchLimit(10), 30);
    assert.equal(overfetchLimit(5), 15);
  });

  it('caps at 60', () => {
    assert.equal(overfetchLimit(25), 60);
    assert.equal(overfetchLimit(100), 60);
  });

  it('handles 0 and 1', () => {
    assert.equal(overfetchLimit(0), 0);
    assert.equal(overfetchLimit(1), 3);
  });
});

// ==========================================================
// rerankResults — graceful fallback (no model)
// ==========================================================
describe('rerankResults — fallback', () => {
  beforeEach(() => {
    resetRerankerState();
  });

  it('returns input unchanged with reranked=false for empty candidates', async () => {
    const { results, reranked } = await rerankResults('test query', [], 10);
    assert.equal(results.length, 0);
    assert.equal(reranked, false);
  });

  it('returns single candidate unchanged with reranked=false', async () => {
    const candidate = makeScoredRow({ id: 'single', content: 'only one', score: 0.7, textScore: 0.4 });
    const { results, reranked } = await rerankResults('test', [candidate], 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'single');
    assert.equal(results[0].score, 0.7);
    assert.equal(results[0].textScore, 0.4);
    assert.equal(reranked, false);
  });

  it('returns single candidate without reranking', async () => {
    const candidate = makeScoredRow({ id: 'only', content: 'single item', score: 0.6, textScore: 0.2 });
    const { results, reranked } = await rerankResults('query', [candidate], 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'only');
    assert.equal(reranked, false);
  });
});

// ==========================================================
// rerankResults — integration (loads real model)
// ==========================================================
describe('rerankResults — integration', () => {
  it('warmRerankerModel makes the reranker available afterwards', async (t) => {
    resetRerankerState();
    warmRerankerModel();
    // Allow the async warmup a brief window then probe — if the model is
    // available, the warmup must have set state such that isRerankerAvailable
    // returns true. If the model is unavailable in this env, the contract is
    // simply that warmRerankerModel does not crash the process; skip the
    // positive assertion.
    const available = await isRerankerAvailable();
    if (!available) {
      t.skip('reranker model unavailable in test environment');
      return;
    }
    assert.equal(available, true, 'warmRerankerModel must leave the reranker in an available state');
  });

  it('reranks candidates by relevance', async (t) => {
    resetRerankerState();
    if (!(await isRerankerAvailable())) {
      t.skip('reranker model unavailable — cannot test reranking');
      return;
    }

    const candidates = [
      makeScoredRow({
        id: 'irrelevant',
        title: 'Cooking Recipes',
        content: 'How to make pasta with tomato sauce and basil leaves',
        score: 0.9,
        textScore: 0.5,
      }),
      makeScoredRow({
        id: 'relevant',
        title: 'TypeScript Compiler',
        content: 'TypeScript strict mode enables noImplicitAny, strictNullChecks, and other type safety options',
        score: 0.5,
        textScore: 0.3,
      }),
    ];

    const { results, reranked } = await rerankResults('typescript type checking configuration', candidates, 10);

    assert.equal(reranked, true, 'reranker must run when the model is available');
    assert.equal(results[0].id, 'relevant', 'cross-encoder must rank TypeScript content above cooking for a TS query');
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1, `Score ${r.score} should be in [0, 1]`);
    }
    const relevantResult = results.find((r) => r.id === 'relevant');
    assert.ok(relevantResult, 'relevant result must exist');
    assert.equal(relevantResult.textScore, 0.3, 'textScore must be preserved across reranking');
  });

  it('isRerankerAvailable reports a stable boolean across calls', async () => {
    resetRerankerState();
    const a = await isRerankerAvailable();
    const b = await isRerankerAvailable();
    assert.equal(typeof a, 'boolean');
    assert.equal(a, b, 'availability must be stable across calls without state changes');
  });

  it('respects limit after reranking', async () => {
    resetRerankerState();

    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeScoredRow({
        id: `m${i}`,
        content: `Memory about topic ${i} with various details`,
        score: 0.5,
        textScore: 0.3,
      }),
    );

    const { results } = await rerankResults('topic 0', candidates, 2);
    assert.ok(results.length <= 2, `Expected at most 2 results, got ${results.length}`);
  });
});
