import type { MemoryDatabase } from '../database.js';
import type { MemoryRow } from '../types.js';
import { generateEmbedding } from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { extractGitSignals } from './git-signals.js';

export async function handleSessionStart(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();

  // Phase 1: Git signals
  const uniqueSignals = extractGitSignals(cwd);

  // Phase 2: Cleanup
  const workingCleaned = db.deleteAllWorkingMemories();
  const episodicCleaned = db.cleanupOldEpisodicMemories(90);
  const decayed = db.decayImportance(30, 0.05);

  const sessionCount = parseInt(db.getSessionMeta('session_count') ?? '0', 10) + 1;
  db.setSessionMeta('session_count', String(sessionCount));

  // Phase 3: Context-aware retrieval with hybrid search
  const sections: string[] = [];
  const seenIds = new Set<string>();

  if (uniqueSignals.length > 0) {
    const searchQuery = uniqueSignals.slice(0, 5).join(' ');
    let queryEmbedding: Float32Array | null = null;
    try {
      queryEmbedding = await generateEmbedding(searchQuery);
    } catch {
      /* embedding generation failed — fall back to FTS only */
    }
    const relevantMemories = db.hybridSearchMemories(searchQuery, queryEmbedding, 10);

    if (relevantMemories.length > 0) {
      sections.push('## Relevant to Current Work');
      for (const mem of relevantMemories) {
        seenIds.add(mem.id);
        const titlePart = mem.title ? `**${mem.title}:** ` : '';
        sections.push(`- [${mem.type}] ${titlePart}${mem.content.slice(0, 200)}`);
      }
    }
  }

  // Recent episodic
  const recentEpisodic = db.getRecentByType('episodic', 3);
  appendSection(sections, seenIds, recentEpisodic, '\n## Recent Sessions', (mem) => {
    const date = mem.created_at.slice(0, 10);
    const ctx = mem.context ? ` (${mem.context})` : '';
    return `- [${date}]${ctx} ${mem.content.slice(0, 200)}`;
  });

  // Top semantic
  const semanticMems = db.getTopByImportance('semantic', 0.5, 5);
  appendSection(sections, seenIds, semanticMems, '\n## Key Knowledge', (mem) => {
    const titlePart = mem.title ? `**${mem.title}:** ` : '';
    return `- ${titlePart}${mem.content.slice(0, 200)}`;
  });

  // Top patterns
  const patterns = db.getTopByImportance('pattern', 0, 5);
  appendSection(sections, seenIds, patterns, '\n## Patterns & Conventions', (mem) => {
    const title = mem.title ?? 'Untitled pattern';
    return `- **${title}:** ${mem.content.slice(0, 200)}`;
  });

  // Top procedural
  const procedures = db.getTopByImportance('procedural', 0.5, 3);
  appendSection(sections, seenIds, procedures, '\n## Procedures', (mem) => {
    const titlePart = mem.title ? `**${mem.title}:** ` : '';
    return `- ${titlePart}${mem.content.slice(0, 200)}`;
  });

  // Phase 4: Consolidation trigger
  const lastConsolidation = parseInt(db.getSessionMeta('last_consolidation') ?? '0', 10);
  const consolidationNeeded = sessionCount - lastConsolidation >= 10;
  if (consolidationNeeded) {
    db.setSessionMeta('last_consolidation', String(sessionCount));
  }

  // Phase 5: Format output
  const cleanupParts: string[] = [];
  if (workingCleaned) cleanupParts.push(`${workingCleaned} working cleared`);
  if (episodicCleaned) cleanupParts.push(`${episodicCleaned} old episodic archived`);
  if (decayed) cleanupParts.push(`${decayed} decayed`);
  const cleanupNote = cleanupParts.length > 0 ? ` (${cleanupParts.join(', ')})` : '';

  const header = `# Project Memory Context (${seenIds.size} items loaded, session #${sessionCount})${cleanupNote}\n`;

  const behavioralInstructions = `
## Memory System

You have project memory via MCP tools. Use it automatically without asking.

### Auto-Recall
- On errors: \`memory_search\` with error keywords
- Starting a module: \`memory_search\` with module/component name
- Before decisions: \`memory_search\` for prior decisions (filter type "pattern" or tag "decision")

### Auto-Save
After resolving non-trivial problems, silently store what you learned:
- Bug fix → \`memory_store\` type "episodic" (what broke + fix)
- Project fact → \`memory_store\` type "semantic" (with title)
- Procedure → \`memory_store\` type "procedural"
- Pattern noticed → \`memory_store\` type "pattern" (with title, importance 0.8)

### Rules
- Search before storing (avoid duplicates)
- Be concise (1-3 sentences per memory)
- Lowercase hyphenated tags
- Don't store trivial actions
- Don't ask user before saving`;

  let consolidationPrompt = '';
  if (consolidationNeeded) {
    consolidationPrompt = `

### Consolidation Due

Before starting the user's task, spend a moment on memory maintenance:

1. \`memory_list\` — check totals per type
2. \`memory_search\` broad terms to find duplicates → merge or delete redundant ones
3. Multiple episodic memories about the same topic → create one \`pattern\` memory, link with \`derived_from\`
4. Lower importance of stale memories not worth keeping
5. Check for contradictions → link with \`contradicts\` relation
6. Briefly report what you cleaned up, then proceed with the task`;
  }

  const context = header + sections.join('\n') + behavioralInstructions + consolidationPrompt;

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
  memories: MemoryRow[],
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
