import type { MemoryDatabase } from '../database.js';
import type { HookInput, HookOutput } from './types.js';
import { generateEmbedding } from '../embeddings.js';
import { TYPE_LIMITS_PER_HOOK, TYPE_RELEVANCE } from '../thresholds.js';
import { formatBlockWithRelations, formatWarningBlock } from './injection-format.js';
import { dedupSet, markInjected } from './session-cache.js';
import { classifyCommand } from './transcript.js';

export async function handlePreToolUse(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const tool = input.tool_name ?? '';
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

  try {
    switch (tool) {
      case 'Edit':
      case 'Write':
      case 'NotebookEdit':
        return await handleEditWrite(db, cwd, toolInput);
      case 'Bash':
        return await handleBash(db, cwd, toolInput);
      case 'Read':
      case 'Grep':
      case 'Glob':
        return await handleReadScan(db, cwd, toolInput);
      case 'WebFetch':
      case 'WebSearch':
        return await handleWeb(db, cwd, toolInput);
      default:
        return empty();
    }
  } catch {
    return empty();
  }
}

async function handleEditWrite(
  db: MemoryDatabase,
  cwd: string,
  toolInput: Record<string, unknown>,
): Promise<HookOutput> {
  const filePath = (toolInput.file_path as string) ?? (toolInput.notebook_path as string) ?? '';
  if (!filePath) return empty();

  const topic = filePath.split('/').slice(-2).join(' ');
  // Tokenize the path so FTS can match individual segments. Passing the raw
  // path to sanitizeFtsQuery wraps it as a single phrase token, which the
  // porter tokenizer then fails to match against documents indexed segment-wise.
  const ftsQuery = pathToFtsQuery(filePath);
  const embedding = await generateEmbedding(`${filePath} ${topic}`);
  const cache = dedupSet(cwd);

  const results = db
    .hybridSearchMemories(ftsQuery, embedding, 10, { relevanceThreshold: TYPE_RELEVANCE.pattern })
    .filter((r) => r.type === 'pattern' && !cache.has(r.id))
    .slice(0, TYPE_LIMITS_PER_HOOK.preToolUse.pattern);

  if (results.length === 0) return empty();

  const top = results[0];
  markInjected(cwd, [top.id]);
  db.incrementInjectionCount([top.id]);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: formatWarningBlock(top, filePath),
    },
  };
}

async function handleBash(
  db: MemoryDatabase,
  cwd: string,
  toolInput: Record<string, unknown>,
): Promise<HookOutput> {
  const cmd = (toolInput.command as string) ?? '';
  if (!cmd) return empty();
  const category = classifyCommand(cmd);
  if (category === 'other' || category === 'git') return empty();

  const hit = db.findMemoryByTag('procedural', category);
  if (!hit) return empty();

  const cache = dedupSet(cwd);
  if (cache.has(hit.id)) return empty();
  markInjected(cwd, [hit.id]);
  db.incrementInjectionCount([hit.id]);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `## Procedural memory for ${category}\n\n**${hit.title ?? category}:** ${hit.content}\n`,
    },
  };
}

async function handleReadScan(
  db: MemoryDatabase,
  cwd: string,
  toolInput: Record<string, unknown>,
): Promise<HookOutput> {
  const path = (toolInput.file_path as string) ?? (toolInput.pattern as string) ?? '';
  if (!path) return empty();
  const ftsQuery = pathToFtsQuery(path);
  const embedding = await generateEmbedding(path);
  const cache = dedupSet(cwd);

  const results = db
    .hybridSearchMemories(ftsQuery, embedding, 10, { relevanceThreshold: TYPE_RELEVANCE.semantic })
    .filter((r) => ['semantic', 'episodic'].includes(r.type) && !cache.has(r.id))
    .slice(0, TYPE_LIMITS_PER_HOOK.preToolUse.total);

  if (results.length === 0) return empty();
  const ids = results.map((r) => r.id);
  markInjected(cwd, ids);
  db.incrementInjectionCount(ids);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: formatBlockWithRelations(results, [], { sessionNum: currentSessionNum(db) }),
    },
  };
}

async function handleWeb(
  db: MemoryDatabase,
  cwd: string,
  toolInput: Record<string, unknown>,
): Promise<HookOutput> {
  const q = (toolInput.query as string) ?? (toolInput.url as string) ?? '';
  if (!q) return empty();
  const embedding = await generateEmbedding(q);
  const cache = dedupSet(cwd);

  const results = db
    .hybridSearchMemories(q, embedding, 5, { relevanceThreshold: 0.3 })
    .filter((r) => r.type === 'semantic' && !cache.has(r.id))
    .slice(0, 2);
  if (results.length === 0) return empty();

  const ids = results.map((r) => r.id);
  markInjected(cwd, ids);
  db.incrementInjectionCount(ids);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: formatBlockWithRelations(results, [], {
        sessionNum: currentSessionNum(db),
        heading: '## Memory before Web search',
      }),
    },
  };
}

/** Split a file path into space-separated tokens for FTS. */
function pathToFtsQuery(filePath: string): string {
  return filePath
    .split(/[/\\.]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .join(' ');
}

function currentSessionNum(db: MemoryDatabase): number {
  const v = db.getSessionMeta('session_count');
  return v ? parseInt(v, 10) : 0;
}

function empty(): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '' } };
}
