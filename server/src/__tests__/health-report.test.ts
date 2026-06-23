import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderHealthReport } from '../cli/health-report.js';
import type { HealthStats } from '../database.js';

function makeStats(overrides: Partial<HealthStats> = {}): HealthStats {
  return {
    total: 42,
    byType: { semantic: 20, episodic: 15, pattern: 7 },
    withEmbedding: 40,
    withoutEmbedding: 2,
    staleCount: 3,
    ageDistribution: { last24h: 1, last7d: 5, last30d: 10, older: 26 },
    sessionCount: 12,
    lastConsolidation: 10,
    qualityMetrics: {
      accessedRatio: 0.5,
      avgImportance: 0.62,
      importanceDistribution: { low: 4, medium: 30, high: 8 },
      injectionStats: {
        totalInjections: 137,
        neverInjected: 9,
        avgInjectionCount: 3.26,
        topInjected: 21,
      },
    },
    relationStats: {
      relCount: 18,
      linkDensity: 0.86,
      isolated: 5,
      avgRelWeight: 0.55,
      strongRelShare: 0.66,
      lastSweep: 0,
    },
    ...overrides,
  };
}

describe('renderHealthReport', () => {
  it('renders the legible headline as items / sessions / injections served', () => {
    const out = renderHealthReport(makeStats(), {
      fileSize: '1.20 MB',
      embAvailable: true,
      rerankerAvailable: true,
    });
    assert.ok(out.includes('**42 items / 12 sessions / 137 injections served**'));
  });

  it('shows never-injected dead weight and the section assertions consumers rely on', () => {
    const out = renderHealthReport(makeStats(), {
      fileSize: '1.20 MB',
      embAvailable: true,
      rerankerAvailable: true,
    });
    assert.ok(out.includes('Never injected (>7d):** 9 memories (dead weight)'));
    assert.ok(out.includes('Memory Health Report'));
    assert.ok(out.includes('Total:** 42'));
    assert.ok(out.includes('Embedding Coverage'));
    assert.ok(out.includes('Staleness'));
    assert.ok(out.includes('Age Distribution'));
    assert.ok(out.includes('Session Info'));
  });

  it('reports embeddings and reranker models plainly as down when unavailable', () => {
    const out = renderHealthReport(makeStats(), {
      fileSize: 'unknown',
      embAvailable: false,
      rerankerAvailable: false,
    });
    assert.ok(out.includes('**Embeddings model:** down'));
    assert.ok(out.includes('**Reranker model:** down'));
  });
});
