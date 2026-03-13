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
  it('warmRerankerModel does not throw', () => {
    resetRerankerState();
    assert.doesNotThrow(() => warmRerankerModel());
  });

  it('reranks candidates by relevance', async () => {
    resetRerankerState();

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

    if (reranked) {
      assert.equal(results[0].id, 'relevant', 'Cross-encoder should rank TypeScript content higher for TS query');
      // Scores should be in [0, 1]
      for (const r of results) {
        assert.ok(r.score >= 0 && r.score <= 1, `Score ${r.score} should be in [0, 1]`);
      }
      // textScore should be preserved from original
      const relevantResult = results.find((r) => r.id === 'relevant');
      assert.ok(relevantResult, 'relevant result should exist');
      assert.equal(relevantResult.textScore, 0.3, 'textScore should be preserved');
    } else {
      // Model not available (e.g. CI without model cache) — still passes
      assert.ok(true, 'Model unavailable, fallback used');
    }
  });

  it('isRerankerAvailable returns boolean', async () => {
    resetRerankerState();
    const available = await isRerankerAvailable();
    assert.equal(typeof available, 'boolean');
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
