import type { MemoryDatabase, ScoredMemoryRow, RelevanceFilterOptions } from '../database.js';
import type { MemoryRow } from '../types.js';
import { generateEmbeddings, warmEmbeddingModel } from '../embeddings.js';
import { warmRerankerModel } from '../reranker.js';
import type { HookInput, HookOutput } from './types.js';
import { extractGitSignals } from './git-signals.js';
import { splitByTopics, insertSplitSections } from '../topic-splitter.js';
import { safeParseTags } from '../merge-utils.js';
import { detectAndStorePatterns } from './pattern-detector.js';
import { THRESHOLDS, TYPE_RELEVANCE, TYPE_LIMITS_PER_HOOK } from '../thresholds.js';
import type { ScoringWeights } from '../thresholds.js';
import { formatBlockWithRelations } from './injection-format.js';
import { expandByRelations } from './relation-walk.js';
import { resetCache, markInjected } from './session-cache.js';

interface SearchChannel {
  query: string;
  weight: number;
  scoringWeights?: ScoringWeights;
}

// Legacy alias — kept for downstream tests (budget-allocation.test.ts).
export const CONTEXT_BUDGET = {
  total: 25,
  relevant: { min: 3, max: 15 },
  episodic: { min: 1, max: 5 },
  semantic: { min: 2, max: 8 },
  pattern: { min: 1, max: 5 },
  procedural: { min: 1, max: 5 },
} as const;

type SectionName = 'relevant' | 'episodic' | 'semantic' | 'pattern' | 'procedural';

interface ContextCandidate {
  memory: MemoryRow | ScoredMemoryRow;
  quality: number;
}

interface ContextSection {
  name: SectionName;
  heading: string;
  candidates: ContextCandidate[];
  format: (mem: MemoryRow | ScoredMemoryRow, quality: number) => string;
}

// allocateBudget is exported and used by budget-allocation.test.ts — keep the contract.
export function allocateBudget(sections: ContextSection[]): {
  allocated: Map<SectionName, ContextCandidate[]>;
  seenIds: Set<string>;
} {
  const allocated = new Map<SectionName, ContextCandidate[]>();
  const seenIds = new Set<string>();
  let remaining = CONTEXT_BUDGET.total;

  for (const section of sections) {
    allocated.set(section.name, []);
  }

  for (const section of sections) {
    const config = CONTEXT_BUDGET[section.name];
    const items = allocated.get(section.name);
    if (!items) continue;
    for (const candidate of section.candidates) {
      if (items.length >= config.min || remaining <= 0) break;
      if (seenIds.has(candidate.memory.id)) continue;
      items.push(candidate);
      seenIds.add(candidate.memory.id);
      remaining--;
    }
  }

  const pool: Array<{ section: SectionName; candidate: ContextCandidate }> = [];
  for (const section of sections) {
    for (const candidate of section.candidates) {
      if (seenIds.has(candidate.memory.id)) continue;
      pool.push({ section: section.name, candidate });
    }
  }
  pool.sort((a, b) => b.candidate.quality - a.candidate.quality);

  for (const { section, candidate } of pool) {
    if (remaining <= 0) break;
    const config = CONTEXT_BUDGET[section];
    const items = allocated.get(section);
    if (!items || items.length >= config.max) continue;
    items.push(candidate);
    seenIds.add(candidate.memory.id);
    remaining--;
  }

  return { allocated, seenIds };
}

const SESSION_CAPS = TYPE_LIMITS_PER_HOOK.sessionStart;

export async function handleSessionStart(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();

  warmEmbeddingModel();
  warmRerankerModel();

  const signals = extractGitSignals(cwd);
  const workingCleaned = db.deleteAllWorkingMemories();
  const episodicCleaned = db.cleanupOldEpisodicMemories(60);
  const { decayed, deleted: stalePruned } = db.decayImportanceByType();
  const relDecayed = db.decayRelationWeights();
  const relPruned = db.pruneStaleRelations();

  const lastSweep = parseInt(db.getSessionMeta('last_sweep_session') ?? '0', 10);
  let sweepCreated = 0;

  const sessionCount = parseInt(db.getSessionMeta('session_count') ?? '0', 10) + 1;
  db.setSessionMeta('session_count', String(sessionCount));
  resetCache(cwd, String(sessionCount));

  if (sessionCount - lastSweep >= 20) {
    try {
      const sweep = db.sweepRelations();
      sweepCreated = sweep.created;
    } catch {
      // best-effort
    }
  }

  const channels: SearchChannel[] = [];
  if (signals.cwd.length > 0)
    channels.push({ query: signals.cwd.join(' '), weight: 1.0, scoringWeights: THRESHOLDS.SCORING_WEIGHTS_CWD });
  if (signals.branch.length > 0)
    channels.push({ query: signals.branch.join(' '), weight: 1.0, scoringWeights: THRESHOLDS.SCORING_WEIGHTS_BRANCH });
  if (signals.commitMessages.length > 0) channels.push({ query: signals.commitMessages.join('. '), weight: 0.8 });
  if (signals.files.length > 0) channels.push({ query: signals.files.slice(0, 8).join(' '), weight: 0.8 });

  const recentEp = db.getRecentByType('episodic', 1);
  const prevTaskMatch = recentEp[0]?.content.match(/\*\*Task:\*\*\s*(.+?)(?:\n|$)/);
  const prevTask = prevTaskMatch?.[1]?.trim();
  if (prevTask && prevTask.length > 15 && !prevTask.startsWith('[Request interrupted')) {
    channels.push({ query: prevTask, weight: 0.9 });
  }

  const overviewTerms: string[] = [];
  if (signals.cwd.length > 0) overviewTerms.push(signals.cwd[0]);
  if (signals.branch.length > 0) overviewTerms.push(signals.branch[0]);
  if (signals.commits.length > 0) overviewTerms.push(signals.commits[0]);
  if (signals.files.length > 0) overviewTerms.push(signals.files[0]);
  const overviewQuery = overviewTerms.length > 0 ? [...new Set(overviewTerms)].join(' ') : '';

  const allQueries = channels.map((c) => c.query);
  if (overviewQuery && !allQueries.includes(overviewQuery)) {
    allQueries.push(overviewQuery);
  }

  let embeddings: (Float32Array | null)[] = [];
  if (allQueries.length > 0) {
    try {
      embeddings = await generateEmbeddings(allQueries);
    } catch {
      embeddings = allQueries.map(() => null);
    }
  }

  const channelEmbeddings = embeddings.slice(0, channels.length);
  const overviewEmbedding = overviewQuery
    ? allQueries.indexOf(overviewQuery) < channels.length
      ? channelEmbeddings[allQueries.indexOf(overviewQuery)]
      : embeddings[embeddings.length - 1]
    : null;

  const sessionFilter: RelevanceFilterOptions = { topicThreshold: 0.08, relevanceThreshold: 0.15 };

  // --- Phase 1: collect primary candidates (up to SESSION_CAPS.total = 10) ---

  // Gather relevant candidates from multi-channel search, filtered by per-type relevance thresholds.
  const relevantCandidates: ContextCandidate[] = [];
  if (channels.length > 0) {
    const mergedScores = new Map<string, { memory: ScoredMemoryRow; bestScore: number }>();

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      const embedding = channelEmbeddings[i] ?? null;
      const results = db.hybridSearchMemories(channel.query, embedding, 10, sessionFilter, channel.scoringWeights);

      for (const result of results) {
        const weightedScore = channel.weight * result.score;
        const existing = mergedScores.get(result.id);
        if (!existing || weightedScore > existing.bestScore) {
          mergedScores.set(result.id, { memory: result, bestScore: weightedScore });
        }
      }
    }

    const ranked = [...mergedScores.values()].sort((a, b) => b.bestScore - a.bestScore);

    for (const { memory, bestScore } of ranked) {
      // Filter out procedural (not surfaced at SessionStart) and apply per-type thresholds.
      if (memory.type === 'procedural') continue;
      const threshold = TYPE_RELEVANCE[memory.type as keyof typeof TYPE_RELEVANCE];
      if (threshold !== undefined && bestScore < threshold) continue;
      relevantCandidates.push({ memory, quality: bestScore });
    }
  }

  // Per-type caps for primary selection.
  const typeCounts: Partial<Record<string, number>> = {};
  const primaryMemories: MemoryRow[] = [];
  const seenPrimaryIds = new Set<string>();

  // Fill from channel search results first (already quality-ranked).
  for (const { memory } of relevantCandidates) {
    if (primaryMemories.length >= SESSION_CAPS.total) break;
    if (seenPrimaryIds.has(memory.id)) continue;
    const t = memory.type as keyof typeof SESSION_CAPS;
    const cap = SESSION_CAPS[t] as number | undefined;
    if (cap !== undefined && (typeCounts[t] ?? 0) >= cap) continue;
    primaryMemories.push(memory);
    seenPrimaryIds.add(memory.id);
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  }

  // Fill remaining slots from static fallbacks (episodic, semantic, pattern) if not already at cap.
  if (primaryMemories.length < SESSION_CAPS.total) {
    const episodicCap = SESSION_CAPS.episodic - (typeCounts['episodic'] ?? 0);
    if (episodicCap > 0) {
      const recent = db.getRecentByType('episodic', episodicCap);
      for (const mem of recent) {
        if (primaryMemories.length >= SESSION_CAPS.total) break;
        if (seenPrimaryIds.has(mem.id)) continue;
        primaryMemories.push(mem);
        seenPrimaryIds.add(mem.id);
        typeCounts['episodic'] = (typeCounts['episodic'] ?? 0) + 1;
      }
    }
  }

  if (primaryMemories.length < SESSION_CAPS.total) {
    const semanticCap = SESSION_CAPS.semantic - (typeCounts['semantic'] ?? 0);
    if (semanticCap > 0) {
      const semanticMems = db
        .getTopByImportance('semantic', 0.5, semanticCap)
        .filter((m) => !seenPrimaryIds.has(m.id));
      for (const mem of semanticMems) {
        if (primaryMemories.length >= SESSION_CAPS.total) break;
        primaryMemories.push(mem);
        seenPrimaryIds.add(mem.id);
        typeCounts['semantic'] = (typeCounts['semantic'] ?? 0) + 1;
      }
    }
  }

  if (primaryMemories.length < SESSION_CAPS.total) {
    const patternCap = SESSION_CAPS.pattern - (typeCounts['pattern'] ?? 0);
    if (patternCap > 0) {
      const patterns = db.getTopByImportance('pattern', 0, patternCap).filter((m) => !seenPrimaryIds.has(m.id));
      for (const mem of patterns) {
        if (primaryMemories.length >= SESSION_CAPS.total) break;
        primaryMemories.push(mem);
        seenPrimaryIds.add(mem.id);
        typeCounts['pattern'] = (typeCounts['pattern'] ?? 0) + 1;
      }
    }
  }

  // --- Phase 2: relation-walk expansion ---
  const neighbours = expandByRelations(db, [...seenPrimaryIds], {
    maxNeighbors: 2,
    minWeight: 0.5,
    dedupSet: new Set(seenPrimaryIds),
    typeCaps: {},
  });

  // --- Increment injection counts for primaries and neighbours ---
  const allInjectedIds = [...seenPrimaryIds, ...neighbours.map((n) => n.memory.id)];
  if (allInjectedIds.length > 0) {
    db.incrementInjectionCount(allInjectedIds);
    markInjected(cwd, allInjectedIds);
  }

  // --- Auto-consolidation ---
  const accumulatedWeight = parseFloat(db.getSessionMeta('consolidation_weight') ?? '0');
  const lastConsolidation = parseInt(db.getSessionMeta('last_consolidation') ?? '0', 10);
  const consolidationNeeded =
    accumulatedWeight >= THRESHOLDS.CONSOLIDATION_WEIGHT_THRESHOLD ||
    sessionCount - lastConsolidation >= THRESHOLDS.CONSOLIDATION_SESSION_FALLBACK;

  let consolidationNote = '';
  if (consolidationNeeded) {
    try {
      consolidationNote = await autoConsolidate(db);
      db.setSessionMeta('last_consolidation', String(sessionCount));
      db.setSessionMeta('consolidation_weight', '0');
    } catch {
      // Will retry next session
    }
  }

  // --- Build output ---
  const cleanupParts: string[] = [];
  if (workingCleaned) cleanupParts.push(`${workingCleaned} working cleared`);
  if (episodicCleaned) cleanupParts.push(`${episodicCleaned} old episodic archived`);
  if (decayed) cleanupParts.push(`${decayed} decayed`);
  if (stalePruned) cleanupParts.push(`${stalePruned} stale pruned`);
  if (relDecayed) cleanupParts.push(`${relDecayed} relations decayed`);
  if (relPruned) cleanupParts.push(`${relPruned} relations pruned`);
  if (sweepCreated) cleanupParts.push(`${sweepCreated} relations discovered`);
  if (consolidationNote) cleanupParts.push(consolidationNote);
  const cleanupNote = cleanupParts.length > 0 ? ` (${cleanupParts.join(', ')})` : '';

  const totalInjected = primaryMemories.length + neighbours.length;
  const header = `# Project Memory Context (${totalInjected} items loaded, session #${sessionCount})${cleanupNote}\n`;

  const memoryBlock = formatBlockWithRelations(
    primaryMemories,
    neighbours.map((n) => ({ memory: n.memory, relationType: n.relationType })),
    {
      sessionNum: sessionCount,
      heading: '## Recalled Memories',
    },
  );

  const context = header + (memoryBlock ? '\n' + memoryBlock : '');

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  };
}

async function autoConsolidate(db: MemoryDatabase): Promise<string> {
  const actions: string[] = [];

  const types = ['episodic', 'semantic', 'procedural', 'pattern'] as const;
  let totalMerged = 0;

  for (const type of types) {
    const pairs = db.findNearDuplicatePairs(type, THRESHOLDS.NEAR_DUPLICATE, 10);
    for (const pair of pairs) {
      if (db.mergeMemories(pair.id1, pair.id2)) {
        totalMerged++;
      }
    }
  }
  if (totalMerged > 0) actions.push(`${totalMerged} duplicates merged`);

  const splittableTypes = ['semantic', 'procedural'] as const;
  const MAX_SPLITS_PER_CONSOLIDATION = 5;
  let totalSplit = 0;
  const consumedIds = new Set<string>();

  for (const type of splittableTypes) {
    if (totalSplit >= MAX_SPLITS_PER_CONSOLIDATION) break;
    const memories = db.listMemories(type, 50, 0);
    for (const mem of memories) {
      if (totalSplit >= MAX_SPLITS_PER_CONSOLIDATION) break;
      if (consumedIds.has(mem.id)) continue;

      const tags = safeParseTags(mem.tags);
      if (tags.includes('split-origin')) continue;

      try {
        const split = splitByTopics(mem.content, mem.title ?? undefined);
        if (!split.shouldSplit) continue;

        const result = await insertSplitSections(db, split.sections, {
          type,
          context: mem.context,
          source: mem.source,
          tags,
          importance: mem.importance,
        });

        if (result.newIds.length >= 2) {
          db.transaction(() => {
            const existingRelations = db.getRelations(mem.id);
            for (const rel of existingRelations) {
              for (const newId of result.newIds) {
                const sourceId = rel.source_id === mem.id ? newId : rel.source_id;
                const targetId = rel.target_id === mem.id ? newId : rel.target_id;
                if (sourceId !== targetId) {
                  try {
                    db.addRelation(sourceId, targetId, rel.relation_type, rel.weight);
                  } catch {
                    // INSERT OR REPLACE handles duplicates; catch covers unexpected errors
                  }
                }
              }
            }
            db.deleteMemory(mem.id);
          });

          totalSplit++;
          for (const mergedId of result.mergedIds) {
            consumedIds.add(mergedId);
          }
        }
      } catch {
        continue;
      }
    }
  }
  if (totalSplit > 0) actions.push(`${totalSplit} memories split by topic`);

  const patternsCreated = await detectAndStorePatterns(db);
  if (patternsCreated > 0) actions.push(`${patternsCreated} patterns created`);

  const staleDeleted = db.deleteStaleMemories(60, 0.1, 0);
  if (staleDeleted > 0) actions.push(`${staleDeleted} stale deleted`);

  return actions.join(', ');
}
