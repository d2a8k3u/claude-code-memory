import type { MemoryDatabase, ScoredMemoryRow, RelevanceFilterOptions } from '../database.js';
import type { MemoryRow } from '../types.js';
import {
  generateEmbeddings,
  warmEmbeddingModel,
  embeddingToBuffer,
  bufferToEmbedding,
  cosineSimilarity,
} from '../embeddings.js';
import { warmRerankerModel } from '../reranker.js';
import type { HookInput, HookOutput } from './types.js';
import { extractGitSignals } from './git-signals.js';
import { makeMemoryRecord, derivePatternTitle } from './shared.js';
import { splitByTopics, insertSplitSections } from '../topic-splitter.js';
import { safeParseTags } from '../merge-utils.js';
import { THRESHOLDS } from '../thresholds.js';

interface SearchChannel {
  query: string;
  weight: number;
}

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
    const items = allocated.get(section.name)!;
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
    if (allocated.get(section)!.length >= config.max) continue;
    allocated.get(section)!.push(candidate);
    seenIds.add(candidate.memory.id);
    remaining--;
  }

  return { allocated, seenIds };
}

export async function handleSessionStart(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();

  warmEmbeddingModel();
  warmRerankerModel();

  const signals = extractGitSignals(cwd);
  const workingCleaned = db.deleteAllWorkingMemories();
  const episodicCleaned = db.cleanupOldEpisodicMemories(90);
  const decayed = db.decayImportance(30, 0.05);

  const sessionCount = parseInt(db.getSessionMeta('session_count') ?? '0', 10) + 1;
  db.setSessionMeta('session_count', String(sessionCount));

  const channels: SearchChannel[] = [];
  if (signals.cwd.length > 0) channels.push({ query: signals.cwd.join(' '), weight: 1.0 });
  if (signals.branch.length > 0) channels.push({ query: signals.branch.join(' '), weight: 1.0 });
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

  const contextSections: ContextSection[] = [];

  const relevantCandidates: ContextCandidate[] = [];
  if (channels.length > 0) {
    const mergedScores = new Map<string, { memory: ScoredMemoryRow; bestScore: number }>();

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      const embedding = channelEmbeddings[i] ?? null;
      const results = db.hybridSearchMemories(channel.query, embedding, 10, sessionFilter);

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
      relevantCandidates.push({ memory, quality: bestScore });
    }
  }

  contextSections.push({
    name: 'relevant',
    heading: '## Relevant to Current Work',
    candidates: relevantCandidates,
    format: (mem, quality) => {
      const titlePart = mem.title ? `**${mem.title}:** ` : '';

      return `- [${mem.type}] ${titlePart}${mem.content} *(score: ${quality.toFixed(2)})*`;
    },
  });

  const recentEpisodic = db.getRecentByType('episodic', CONTEXT_BUDGET.episodic.max);
  contextSections.push({
    name: 'episodic',
    heading: '## Recent Sessions',
    candidates: recentEpisodic.map((mem, i) => ({
      memory: mem,
      quality: 0.7 - i * 0.1,
    })),
    format: (mem, _quality) => {
      const date = mem.created_at.slice(0, 10);
      const ctx = mem.context ? ` (${mem.context})` : '';
      return `- [${date}]${ctx} ${mem.content}`;
    },
  });

  const semanticCandidates: ContextCandidate[] = [];

  if (overviewQuery && overviewEmbedding) {
    const results = db
      .hybridSearchMemories(overviewQuery, overviewEmbedding, 20, sessionFilter)
      .filter((r) => r.type === 'semantic');
    for (const r of results) semanticCandidates.push({ memory: r, quality: r.score });
  } else {
    const mems = db.getTopByImportance('semantic', 0.5, CONTEXT_BUDGET.semantic.max);
    for (const m of mems) semanticCandidates.push({ memory: m, quality: m.importance });
  }
  contextSections.push({
    name: 'semantic',
    heading: '## Key Knowledge',
    candidates: semanticCandidates,
    format: (mem, quality) => {
      const titlePart = mem.title ? `**${mem.title}:** ` : '';
      return `- ${titlePart}${mem.content} *(score: ${quality.toFixed(2)})*`;
    },
  });

  const patterns = db.getTopByImportance('pattern', 0, CONTEXT_BUDGET.pattern.max);
  contextSections.push({
    name: 'pattern',
    heading: '## Patterns & Conventions',
    candidates: patterns.map((m) => ({ memory: m, quality: m.importance })),
    format: (mem, quality) => {
      const title = mem.title ?? 'Untitled pattern';
      return `- **${title}:** ${mem.content} *(score: ${quality.toFixed(2)})*`;
    },
  });

  const proceduralCandidates: ContextCandidate[] = [];
  if (overviewQuery && overviewEmbedding) {
    const results = db
      .hybridSearchMemories(overviewQuery, overviewEmbedding, 15, sessionFilter)
      .filter((r) => r.type === 'procedural');
    for (const r of results) proceduralCandidates.push({ memory: r, quality: r.score });
  } else {
    const mems = db.getTopByImportance('procedural', 0.5, CONTEXT_BUDGET.procedural.max);
    for (const m of mems) proceduralCandidates.push({ memory: m, quality: m.importance });
  }
  contextSections.push({
    name: 'procedural',
    heading: '## Procedures',
    candidates: proceduralCandidates,
    format: (mem, quality) => {
      const titlePart = mem.title ? `**${mem.title}:** ` : '';
      return `- ${titlePart}${mem.content} *(score: ${quality.toFixed(2)})*`;
    },
  });

  const { allocated, seenIds } = allocateBudget(contextSections);

  const sections: string[] = [];
  let isFirstSection = true;
  for (const section of contextSections) {
    const items = allocated.get(section.name) ?? [];
    if (items.length === 0) continue;
    sections.push(isFirstSection ? section.heading : `\n${section.heading}`);
    isFirstSection = false;
    for (const item of items) {
      sections.push(section.format(item.memory, item.quality));
    }
  }

  const lastConsolidation = parseInt(db.getSessionMeta('last_consolidation') ?? '0', 10);
  const consolidationNeeded = sessionCount - lastConsolidation >= 10;

  let consolidationNote = '';
  if (consolidationNeeded) {
    try {
      consolidationNote = await autoConsolidate(db);
      db.setSessionMeta('last_consolidation', String(sessionCount));
    } catch {
      // Will retry next session
    }
  }

  const cleanupParts: string[] = [];
  if (workingCleaned) cleanupParts.push(`${workingCleaned} working cleared`);
  if (episodicCleaned) cleanupParts.push(`${episodicCleaned} old episodic archived`);
  if (decayed) cleanupParts.push(`${decayed} decayed`);
  if (consolidationNote) cleanupParts.push(consolidationNote);
  const cleanupNote = cleanupParts.length > 0 ? ` (${cleanupParts.join(', ')})` : '';

  const header = `# Project Memory Context (${seenIds.size} items loaded, session #${sessionCount})${cleanupNote}\n`;

  const behavioralReminder = `

---
**CRITICAL The context above is a broad overview loaded from git signals — it is NOT a substitute for active searching.**
You MUST call \`memory_search\` silently (without asking the user):
- **Before starting work** — search for prior work on the module/feature the user is asking about
- **During work** — whenever you encounter a topic, convention, or decision the user might have discussed before, search memory instead of asking or guessing. The user should never have to say "check your memory" — recall proactively.`;

  const context = header + sections.join('\n') + behavioralReminder;

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

  let patternsCreated = 0;
  const recentEpisodics = db.getRecentEpisodicWithEmbeddings(30, 50);

  const clusterCandidates = recentEpisodics.filter((mem) => {
    const tags = safeParseTags(mem.tags);
    if (!tags.includes('session-end')) return false;
    if (mem.content.includes('[Request interrupted')) return false;
    return true;
  });

  if (clusterCandidates.length >= 3) {
    const existingPatterns = db.getMemoriesByTypeWithEmbeddings('pattern', 20);
    const clusters: number[][] = [];
    const assigned = new Set<number>();

    for (let i = 0; i < clusterCandidates.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [i];
      assigned.add(i);

      const embI = bufferToEmbedding(clusterCandidates[i].embedding);
      for (let j = i + 1; j < clusterCandidates.length; j++) {
        if (assigned.has(j)) continue;
        const embJ = bufferToEmbedding(clusterCandidates[j].embedding);
        const similarity = cosineSimilarity(embI, embJ);
        if (similarity >= THRESHOLDS.CLUSTER_MIN && similarity <= THRESHOLDS.CLUSTER_MAX) {
          cluster.push(j);
          assigned.add(j);
        }
      }

      if (cluster.length >= 3) clusters.push(cluster);
    }

    const patternTexts: string[] = [];
    const patternClusters: number[][] = [];

    for (const cluster of clusters) {
      const dim = 384;
      const centroid = new Float32Array(dim);
      for (const idx of cluster) {
        const emb = bufferToEmbedding(clusterCandidates[idx].embedding);
        for (let d = 0; d < dim; d++) centroid[d] += emb[d];
      }
      for (let d = 0; d < dim; d++) centroid[d] /= cluster.length;
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += centroid[d] * centroid[d];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let d = 0; d < dim; d++) centroid[d] /= norm;

      let covered = false;
      for (const pat of existingPatterns) {
        const patEmb = bufferToEmbedding(pat.embedding);
        if (cosineSimilarity(centroid, patEmb) > THRESHOLDS.PATTERN_OVERLAP) {
          covered = true;
          break;
        }
      }
      if (covered) continue;

      const taskDescriptions = cluster
        .map((idx) => extractTaskFromEpisodic(clusterCandidates[idx].content))
        .filter((t) => t.length > 0);
      const title = derivePatternTitle(taskDescriptions);
      const content = `Recurring theme across ${cluster.length} sessions: ${taskDescriptions.join(' | ')}`;
      patternTexts.push(`${title}: ${content}`);
      patternClusters.push(cluster);
    }

    if (patternTexts.length > 0) {
      const patternEmbeddings = await generateEmbeddings(patternTexts);

      for (let i = 0; i < patternClusters.length; i++) {
        const emb = patternEmbeddings[i];
        if (!emb) continue;

        const similar = db.findSimilarMemory(emb, THRESHOLDS.EXACT_DUPLICATE);
        if (similar) continue;

        const cluster = patternClusters[i];
        const taskDescriptions = cluster
          .map((idx) => extractTaskFromEpisodic(clusterCandidates[idx].content))
          .filter((t) => t.length > 0);
        const title = derivePatternTitle(taskDescriptions);
        const content = patternTexts[i].slice(patternTexts[i].indexOf(':') + 2);

        const importance = patternQualities[i] >= THRESHOLDS.CLUSTER_QUALITY_STRONG ? 0.8 : 0.6;
        const record = makeMemoryRecord('pattern', content, ['auto-pattern'], {
          title,
          importance,
          context: 'auto-consolidation',
        });
        record.embedding = embeddingToBuffer(emb);
        db.insertMemory(record);

        for (const idx of cluster) {
          try {
            db.addRelation(record.id, clusterCandidates[idx].id, 'derived_from', 0.7);
          } catch {
            // Not critical
          }
        }
        patternsCreated++;
      }
    }
  }
  if (patternsCreated > 0) actions.push(`${patternsCreated} patterns created`);

  const staleDeleted = db.deleteStaleMemories(60, 0.1, 0);
  if (staleDeleted > 0) actions.push(`${staleDeleted} stale deleted`);

  return actions.join(', ');
}

function extractTaskFromEpisodic(content: string): string {
  const taskMatch = content.match(/\*\*Task:\*\*\s*(.+?)(?:\n|$)/);
  return taskMatch ? taskMatch[1].trim() : content.slice(0, 100);
}
