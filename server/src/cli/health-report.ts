import type { HealthStats } from '../database.js';

export interface HealthReportContext {
  /** Human-readable database file size, e.g. "1.20 MB". */
  fileSize: string;
  /** Whether the embedding model is loadable. */
  embAvailable: boolean;
  /** Whether the reranker model is loadable. */
  rerankerAvailable: boolean;
}

/**
 * Single source of truth for the /memory-status and memory_health report text.
 * Both the MCP tool and the CLI render through this so their output is identical.
 *
 * Honesty: injection_count is "placed in context", never "acted on", and it is
 * cumulative with no per-session window — so the headline says "injections served"
 * (a lifetime count) and never claims memories were recalled across the last N
 * sessions. Every line is a count already derivable from getHealthStats().
 */
export function renderHealthReport(stats: HealthStats, ctx: HealthReportContext): string {
  const { fileSize, embAvailable, rerankerAvailable } = ctx;
  const { injectionStats } = stats.qualityMetrics;

  const typeLines = Object.entries(stats.byType)
    .map(([type, count]) => `  - ${type}: ${count}`)
    .join('\n');

  return `# Memory Health Report

**${stats.total} items / ${stats.sessionCount} sessions / ${injectionStats.totalInjections} injections served**

**Database:** ${fileSize}
**Embeddings model:** ${embAvailable ? 'up' : 'down'}
**Reranker model:** ${rerankerAvailable ? 'up' : 'down'}

## Counts
- **Total:** ${stats.total}
${typeLines}

## Embedding Coverage
- **With embedding:** ${stats.withEmbedding}
- **Without embedding:** ${stats.withoutEmbedding}
- **Coverage:** ${stats.total > 0 ? ((stats.withEmbedding / stats.total) * 100).toFixed(1) : '0'}%

## Staleness
- **Stale memories** (importance < 0.2, access < 2, older than 30d): ${stats.staleCount}
- **Never injected (>7d):** ${injectionStats.neverInjected} memories (dead weight)

## Age Distribution
- Last 24h: ${stats.ageDistribution.last24h}
- Last 7d: ${stats.ageDistribution.last7d}
- Last 30d: ${stats.ageDistribution.last30d}
- Older: ${stats.ageDistribution.older}

## Session Info
- **Session count:** ${stats.sessionCount}
- **Last consolidation:** session #${stats.lastConsolidation}
- **Sessions since consolidation:** ${stats.sessionCount - stats.lastConsolidation}

## Quality Metrics
- **Accessed ratio:** ${stats.total > 0 ? (stats.qualityMetrics.accessedRatio * 100).toFixed(1) : '0'}% (${Math.round(stats.qualityMetrics.accessedRatio * stats.total)}/${stats.total})
- **Avg importance:** ${stats.qualityMetrics.avgImportance.toFixed(2)}
- **Importance distribution:** low(<0.3): ${stats.qualityMetrics.importanceDistribution.low ?? 0} | mid: ${stats.qualityMetrics.importanceDistribution.medium ?? 0} | high(>=0.7): ${stats.qualityMetrics.importanceDistribution.high ?? 0}
- **Injections:** ${injectionStats.totalInjections} total, avg ${injectionStats.avgInjectionCount.toFixed(1)}/memory, max ${injectionStats.topInjected}

## Relation Graph
- **Relations:** ${stats.relationStats.relCount}
- **Link density:** ${stats.relationStats.linkDensity.toFixed(2)} per memory
- **Isolated nodes:** ${stats.relationStats.isolated}
- **Avg relation weight:** ${stats.relationStats.avgRelWeight.toFixed(2)}
- **Strong relation share (w >= 0.5):** ${(stats.relationStats.strongRelShare * 100).toFixed(1)}%
- **Last sweep:** session #${stats.relationStats.lastSweep}`;
}

/**
 * Gathers the file size and renders the report. Shared by the MCP tool and the
 * CLI status path so both produce identical text from one getHealthStats() call.
 */
export async function buildHealthReport(
  stats: HealthStats,
  dbPath: string,
  availability: { embAvailable: boolean; rerankerAvailable: boolean },
): Promise<string> {
  const { statSync } = await import('node:fs');
  let fileSize = 'unknown';
  try {
    const st = statSync(dbPath);
    fileSize = `${(st.size / (1024 * 1024)).toFixed(2)} MB`;
  } catch {
    // DB path may not be accessible (e.g. in-memory db)
  }
  return renderHealthReport(stats, { fileSize, ...availability });
}
