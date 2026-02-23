import type { MemoryDatabase, ScoredMemoryRow } from '../database.js';
import type { MemoryRow } from '../types.js';
import { generateEmbeddings, warmEmbeddingModel } from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { extractGitSignals } from './git-signals.js';

interface SearchChannel {
  query: string;
  weight: number;
}

export async function handleSessionStart(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();

  warmEmbeddingModel();

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
    ? (allQueries.indexOf(overviewQuery) < channels.length
        ? channelEmbeddings[allQueries.indexOf(overviewQuery)]
        : embeddings[embeddings.length - 1])
    : null;

  const sections: string[] = [];
  const seenIds = new Set<string>();

  if (channels.length > 0) {
    const mergedScores = new Map<string, { memory: ScoredMemoryRow; bestScore: number }>();

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      const embedding = channelEmbeddings[i] ?? null;
      const results = db.hybridSearchMemories(channel.query, embedding, 10);

      for (const result of results) {
        const weightedScore = channel.weight * result.score;
        const existing = mergedScores.get(result.id);
        if (!existing || weightedScore > existing.bestScore) {
          mergedScores.set(result.id, { memory: result, bestScore: weightedScore });
        }
      }
    }

    const ranked = [...mergedScores.values()]
      .sort((a, b) => b.bestScore - a.bestScore)
      .slice(0, 10);

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
    const semanticResults = db.hybridSearchMemories(overviewQuery, overviewEmbedding, 20)
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
    const procedureResults = db.hybridSearchMemories(overviewQuery, overviewEmbedding, 15)
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
  if (consolidationNeeded) {
    db.setSessionMeta('last_consolidation', String(sessionCount));
  }

  const cleanupParts: string[] = [];
  if (workingCleaned) cleanupParts.push(`${workingCleaned} working cleared`);
  if (episodicCleaned) cleanupParts.push(`${episodicCleaned} old episodic archived`);
  if (decayed) cleanupParts.push(`${decayed} decayed`);
  const cleanupNote = cleanupParts.length > 0 ? ` (${cleanupParts.join(', ')})` : '';

  const header = `# Project Memory Context (${seenIds.size} items loaded, session #${sessionCount})${cleanupNote}\n`;

  let consolidationPrompt = '';
  if (consolidationNeeded) {
    const curationStats = db.getCurationStats();
    const typeBreakdown = Object.entries(curationStats.byType)
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');

    const findings: string[] = [];
    if (curationStats.duplicateCandidateCount > 0) {
      findings.push(`- **${curationStats.duplicateCandidateCount} near-duplicate pairs** detected — review and merge or differentiate`);
    }
    if (curationStats.staleCount > 0) {
      findings.push(`- **${curationStats.staleCount} stale memories** (importance < 0.2, access < 2, older than 30 days) — consider deleting or boosting`);
    }
    const findingsBlock = findings.length > 0 ? `\n${findings.join('\n')}\n` : '';

    consolidationPrompt = `

### Consolidation Due

Memory system stats: **${curationStats.total} total** memories (${typeBreakdown}).
${findingsBlock}
Before starting the user's task, spend a moment on memory maintenance:
1. \`memory_search\` broad terms to find duplicates → merge or delete redundant ones
2. Multiple episodic memories about the same topic → create one \`pattern\` memory
3. Lower importance of stale memories not worth keeping
4. Check for contradictions → link with \`contradicts\` relation
5. Briefly report what you cleaned up, then proceed with the task`;
  }

  const behavioralReminder = `

---
**CRITICAL The context above is a broad overview loaded from git signals — it is NOT a substitute for active searching.**
You MUST call \`memory_search\` silently (without asking the user):
- **Before starting work** — search for prior work on the module/feature the user is asking about
- **During work** — whenever you encounter a topic, convention, or decision the user might have discussed before, search memory instead of asking or guessing. The user should never have to say "check your memory" — recall proactively.`;

  const context = header + sections.join('\n') + consolidationPrompt + behavioralReminder;

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  };
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
