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

interface SearchChannel {
  query: string;
  weight: number;
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
  if (signals.commits.length > 0) channels.push({ query: signals.commits.slice(0, 8).join(' '), weight: 0.8 });
  if (signals.files.length > 0) channels.push({ query: signals.files.slice(0, 8).join(' '), weight: 0.8 });

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

  const sections: string[] = [];
  const seenIds = new Set<string>();

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

    const ranked = [...mergedScores.values()].sort((a, b) => b.bestScore - a.bestScore).slice(0, 10);

    if (ranked.length > 0) {
      sections.push('## Relevant to Current Work');
      for (const { memory: mem } of ranked) {
        seenIds.add(mem.id);
        const titlePart = mem.title ? `**${mem.title}:** ` : '';
        sections.push(`- [${mem.type}] ${titlePart}${mem.content}`);
      }
    }
  }

  const recentEpisodic = db.getRecentByType('episodic', 3);
  appendSection(sections, seenIds, recentEpisodic, '\n## Recent Sessions', (mem) => {
    const date = mem.created_at.slice(0, 10);
    const ctx = mem.context ? ` (${mem.context})` : '';
    return `- [${date}]${ctx} ${mem.content}`;
  });

  if (overviewQuery && overviewEmbedding) {
    const semanticResults = db
      .hybridSearchMemories(overviewQuery, overviewEmbedding, 20, sessionFilter)
      .filter((r) => r.type === 'semantic')
      .slice(0, 5);
    appendSection(sections, seenIds, semanticResults, '\n## Key Knowledge', (mem) => {
      const titlePart = mem.title ? `**${mem.title}:** ` : '';
      return `- ${titlePart}${mem.content}`;
    });
  } else {
    const semanticMems = db.getTopByImportance('semantic', 0.5, 5);
    appendSection(sections, seenIds, semanticMems, '\n## Key Knowledge', (mem) => {
      const titlePart = mem.title ? `**${mem.title}:** ` : '';
      return `- ${titlePart}${mem.content}`;
    });
  }

  const patterns = db.getTopByImportance('pattern', 0, 5);
  appendSection(sections, seenIds, patterns, '\n## Patterns & Conventions', (mem) => {
    const title = mem.title ?? 'Untitled pattern';
    return `- **${title}:** ${mem.content}`;
  });

  if (overviewQuery && overviewEmbedding) {
    const procedureResults = db
      .hybridSearchMemories(overviewQuery, overviewEmbedding, 15, sessionFilter)
      .filter((r) => r.type === 'procedural')
      .slice(0, 3);
    appendSection(sections, seenIds, procedureResults, '\n## Procedures', (mem) => {
      const titlePart = mem.title ? `**${mem.title}:** ` : '';
      return `- ${titlePart}${mem.content}`;
    });
  } else {
    const procedures = db.getTopByImportance('procedural', 0.5, 3);
    appendSection(sections, seenIds, procedures, '\n## Procedures', (mem) => {
      const titlePart = mem.title ? `**${mem.title}:** ` : '';
      return `- ${titlePart}${mem.content}`;
    });
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
    const pairs = db.findNearDuplicatePairs(type, 0.08, 10);
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
        if (similarity >= 0.4 && similarity <= 0.95) {
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
        if (cosineSimilarity(centroid, patEmb) > 0.5) {
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

        const similar = db.findSimilarMemory(emb, 0.05);
        if (similar) continue;

        const cluster = patternClusters[i];
        const taskDescriptions = cluster
          .map((idx) => extractTaskFromEpisodic(clusterCandidates[idx].content))
          .filter((t) => t.length > 0);
        const title = derivePatternTitle(taskDescriptions);
        const content = patternTexts[i].slice(patternTexts[i].indexOf(':') + 2);

        const record = makeMemoryRecord('pattern', content, ['auto-pattern'], {
          title,
          importance: 0.8,
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

function appendSection(
  sections: string[],
  seenIds: Set<string>,
  memories: (MemoryRow | ScoredMemoryRow)[],
  heading: string,
  format: (mem: MemoryRow) => string,
): void {
  const unseen = memories.filter((m) => !seenIds.has(m.id));
  if (unseen.length === 0) return;
  sections.push(heading);
  for (const mem of unseen) {
    seenIds.add(mem.id);
    sections.push(format(mem));
  }
}
