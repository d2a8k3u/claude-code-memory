import type { MemoryDatabase } from '../database.js';
import type { HookInput, HookOutput } from './types.js';
import type { MemoryRow, MemoryType } from '../types.js';
import { generateEmbedding } from '../embeddings.js';
import { TYPE_LIMITS_PER_HOOK, TYPE_RELEVANCE } from '../thresholds.js';
import { formatBlockWithRelations } from './injection-format.js';
import { expandByRelations } from './relation-walk.js';
import { dedupSet, markInjected } from './session-cache.js';
import { isRecallStyle } from './recall-detector.js';

const MIN_PROMPT_LEN = 8;

export async function handlePromptSubmit(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const prompt = (input.prompt ?? '').trim();

  if (prompt.length < MIN_PROMPT_LEN) {
    return empty();
  }

  try {
    const embedding = await generateEmbedding(prompt);
    const caps = TYPE_LIMITS_PER_HOOK.userPromptSubmit;
    const cache = dedupSet(cwd);

    const semantic = db
      .hybridSearchMemories(prompt, embedding, caps.semantic * 2, { relevanceThreshold: TYPE_RELEVANCE.semantic })
      .filter((r) => r.type === 'semantic' && !cache.has(r.id))
      .slice(0, caps.semantic);

    const pattern = db
      .hybridSearchMemories(prompt, embedding, caps.pattern * 2, { relevanceThreshold: TYPE_RELEVANCE.pattern })
      .filter((r) => r.type === 'pattern' && !cache.has(r.id))
      .slice(0, caps.pattern);

    let episodic: MemoryRow[] = [];
    if (isRecallStyle(prompt)) {
      episodic = db
        .hybridSearchMemories(prompt, embedding, caps.episodic * 2, { relevanceThreshold: TYPE_RELEVANCE.episodic })
        .filter((r) => r.type === 'episodic' && !cache.has(r.id))
        .slice(0, caps.episodic);
    }

    const primaries: MemoryRow[] = [...semantic, ...pattern, ...episodic].slice(0, caps.total);
    if (primaries.length === 0) return empty();

    const primaryIds = new Set(primaries.map((p) => p.id));

    const remainingTypeCaps: Partial<Record<MemoryType, number>> = {
      semantic: Math.max(0, caps.semantic - semantic.length),
      pattern: Math.max(0, caps.pattern - pattern.length),
      episodic: Math.max(0, caps.episodic - episodic.length),
    };

    const neighbours = expandByRelations(db, [...primaryIds], {
      maxNeighbors: 2,
      minWeight: 0.5,
      dedupSet: new Set([...cache, ...primaryIds]),
      typeCaps: remainingTypeCaps,
    });

    const allIds = [...primaryIds, ...neighbours.map((n) => n.memory.id)];
    db.incrementInjectionCount(allIds);
    markInjected(cwd, allIds);

    const block = formatBlockWithRelations(primaries, neighbours, { sessionNum: currentSessionNum(db) });
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: block,
      },
    };
  } catch {
    return empty();
  }
}

function currentSessionNum(db: MemoryDatabase): number {
  const v = db.getSessionMeta('session_count');
  return v ? parseInt(v, 10) : 0;
}

function empty(): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '' } };
}
