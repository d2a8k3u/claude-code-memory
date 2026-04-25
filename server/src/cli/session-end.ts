import { readFileSync } from 'node:fs';
import type { MemoryDatabase } from '../database.js';
import type { MemoryRow } from '../types.js';
import { generateEmbedding, generateEmbeddings, embeddingToBuffer } from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { parseTranscript, type BashCategory, type TranscriptSummary } from './transcript.js';
import { makeMemoryRecord } from './shared.js';
import { insertWithAutoRelations } from '../memory.js';
import { detectAndStorePatterns } from './pattern-detector.js';
import { extractAll } from './turn-extractor.js';
import { dedupSet } from './session-cache.js';

export { deduplicateTaskDescriptions, extractTaskFromEpisodic } from './pattern-detector.js';

export const SUBSTANCE_THRESHOLD = 4;

const TRIVIAL_COMMAND_PATTERNS = [
  /^(echo|cat|ls|pwd|cd|which|whoami|date|env)\b/,
  /^git\s+(status|log|diff|show|branch|remote|stash\s+list)\b/,
  /^(head|tail|wc|sort|uniq|tr|cut)\b/,
];

export function isTrivialCommand(command: string): boolean {
  const trimmed = command.trim();
  return TRIVIAL_COMMAND_PATTERNS.some((p) => p.test(trimmed));
}

export function parseWorkflowCommands(content: string): string[] {
  const colonIdx = content.indexOf(':');
  if (colonIdx === -1) return [];
  return content
    .slice(colonIdx + 1)
    .split(' && ')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const SEMANTIC_SINGLETON_CAP = 15;

export type ItemWithCount = { name: string; count: number };

export function parseItemsWithCounts(content: string): ItemWithCount[] {
  const colonIdx = content.indexOf(':');
  if (colonIdx === -1) return [];
  return content
    .slice(colonIdx + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(.+?)\((\d+)\)$/);
      if (match) return { name: match[1].trim(), count: parseInt(match[2], 10) };
      return { name: item.trim(), count: 1 };
    });
}

export function formatItemsWithCounts(items: ItemWithCount[]): string {
  return items.map((i) => `${i.name}(${i.count})`).join(', ');
}

export function computeSessionWeight(summary: TranscriptSummary): number {
  const toolWeight = Math.min(summary.toolCallCount, 20) * 0.1;
  const fileWeight = Math.min(summary.filesModified.length, 10) * 0.3;
  const memWeight = (summary.memorySearches + summary.memoryStores) * 0.1;
  const errorWeight = Math.min(summary.errorCount, 5) * 0.1;
  const bashWeight =
    Math.min(
      summary.bashCommands.filter((c) => !isTrivialCommand(c.command)).length,
      10,
    ) * 0.1;
  return toolWeight + fileWeight + memWeight + errorWeight + bashWeight;
}

export function computeSubstanceScore(
  summary: Pick<TranscriptSummary, 'toolsUsed' | 'filesModified' | 'errorCount' | 'memoryStores' | 'bashCommands'>,
): number {
  return (
    summary.toolsUsed.length * 2 +
    summary.filesModified.length * 3 +
    (summary.errorCount > 0 ? 2 : 0) +
    summary.memoryStores +
    Math.min(summary.bashCommands.filter((c) => !isTrivialCommand(c.command)).length, 5)
  );
}

export async function handleSessionEnd(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const summary = parseTranscript(input.transcript_path ?? '', cwd);

  // Co-activation bumps for all pairs of IDs injected this session (always runs)
  try {
    const cache = [...dedupSet(cwd)];
    for (let i = 0; i < cache.length; i++) {
      for (let j = i + 1; j < cache.length; j++) {
        const count = db.incrementCoActivation(cache[i], cache[j]);
        db.boostRelationOnCoInject(cache[i], cache[j]);
        if (count >= 3) {
          try {
            db.addRelation(cache[i], cache[j], 'relates_to', 0.45);
          } catch {
            // already exists
          }
          db.resetCoActivation(cache[i], cache[j]);
        }
      }
    }
  } catch {
    // swallow
  }

  const episodicRecords: (MemoryRow & { embedding?: Buffer | null })[] = [];
  const embeddingTexts: string[] = [];

  // Build unified episodic record as prose (no meta-prefixes)
  const taskSummary = summary.taskSummary ?? '';
  const contentParts: string[] = [];

  if (taskSummary) {
    contentParts.push(taskSummary);
  }

  const factParts: string[] = [];
  if (summary.toolsUsed.length > 0) {
    factParts.push(`Used tools: ${summary.toolsUsed.join(', ')}`);
  }
  if (summary.filesModified.length > 0) {
    const fileList = summary.filesModified.slice(0, 8).join(', ');
    const more = summary.filesModified.length > 8 ? ` (+${summary.filesModified.length - 8} more)` : '';
    factParts.push(
      `Touched ${summary.filesModified.length} file${summary.filesModified.length === 1 ? '' : 's'}: ${fileList}${more}`,
    );
  }
  if (summary.memorySearches > 0 || summary.memoryStores > 0) {
    factParts.push(`Memory ops: ${summary.memorySearches} searches, ${summary.memoryStores} stores`);
  }
  if (summary.errorCount > 0) {
    factParts.push(`${summary.errorCount} error${summary.errorCount === 1 ? '' : 's'} encountered`);
  }

  if (factParts.length > 0) {
    contentParts.push(factParts.join('. ') + '.');
  }

  if (contentParts.length === 0) {
    return { ok: true };
  }

  const isInterrupted = taskSummary.startsWith('[Request interrupted');
  const isShortTask = taskSummary.length < 30;
  const substanceScore = computeSubstanceScore(summary);
  const hasSubstance = substanceScore >= SUBSTANCE_THRESHOLD;
  const isTrivial = summary.toolCallCount < 3 && summary.filesModified.length === 0;

  if (!isInterrupted && !(isShortTask && (!hasSubstance || isTrivial))) {
    const mainContent = contentParts.join(' ');
    const episodicTitle = deriveEpisodicTitle(taskSummary, summary.filesModified);
    episodicRecords.push(
      makeMemoryRecord('episodic', mainContent, ['auto-save', 'session-end'], {
        title: episodicTitle,
        context: 'session-end auto-save',
      }),
    );
    embeddingTexts.push(`${episodicTitle}\n\n${mainContent}`);
  }

  // Handle singleton records by tag-based lookup (one per category, updated in place)
  const successfulByCategory = groupSuccessfulCommands(summary.bashCommands);

  for (const [category, commands] of successfulByCategory) {
    if (commands.length < 3) continue;
    const content = `${categoryLabel(category)} workflow: ${commands.join(' && ')}`;
    await updateOrCreateProcedural(db, content, category);
  }

  if (summary.technologies.length > 0) {
    await mergeOrCreateSemantic(
      db,
      `Technology stack used: ${summary.technologies.join(', ')}`,
      ['auto-semantic', 'tech-stack'],
      'Technology stack',
      'tech-stack',
    );
  }

  const activeModules = extractActiveModules(summary.filesModified);
  if (activeModules.length > 0) {
    await mergeOrCreateSemantic(
      db,
      `Active modules/directories: ${activeModules.join(', ')}`,
      ['auto-semantic', 'active-modules'],
      'Active modules',
      'active-modules',
    );
  }

  // Batch-process episodic records
  const allRecords = [...episodicRecords];
  const embeddings = await generateEmbeddings(embeddingTexts);

  for (let i = 0; i < allRecords.length; i++) {
    const emb = embeddings[i];
    if (emb) {
      allRecords[i].embedding = embeddingToBuffer(emb);
    }
  }

  for (let i = 0; i < allRecords.length; i++) {
    const record = allRecords[i];
    await insertWithAutoRelations(db, record, { strictContent: true });
  }

  // Extractor pass: extra insights beyond the closing episodic
  try {
    const ctx = {
      userMessage: extractLastUserMessage(input.transcript_path ?? ''),
      assistantReply: extractLastAssistantMessage(input.transcript_path ?? ''),
      toolCalls: [
        ...summary.bashCommands.map((c) => ({
          name: 'Bash',
          input: { command: c.command } as Record<string, unknown>,
          output: c.success ? 'ok' : 'error',
        })),
        ...summary.editToolUses.map((e) => ({
          name: e.name,
          input: { file_path: e.file_path } as Record<string, unknown>,
          output: 'ok',
        })),
      ],
      filesRead: summary.filesRead ?? [],
      filesWritten: summary.filesModified,
      errorCount: summary.errorCount,
      sessionId: String(parseInt(db.getSessionMeta('session_count') ?? '0', 10)),
      turnIndex: 0,
    };
    const extras = await extractAll(ctx, db);
    for (const rec of extras) {
      try {
        await insertWithAutoRelations(db, rec, { strictContent: true, generateEmbeddingIfMissing: true });
      } catch {
        // skip this insight
      }
    }
  } catch {
    // swallow
  }

  await detectAndStorePatterns(db);

  const weight = computeSessionWeight(summary);
  const currentWeight = parseFloat(db.getSessionMeta('consolidation_weight') ?? '0');
  db.setSessionMeta('consolidation_weight', String(currentWeight + weight));

  return { ok: true };
}

export function parseListContent(content: string): string[] {
  const colonIdx = content.indexOf(':');
  if (colonIdx === -1) return [];
  return content
    .slice(colonIdx + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function mergeOrCreateSemantic(
  db: MemoryDatabase,
  content: string,
  tags: string[],
  title: string,
  matchTag: string,
): Promise<void> {
  const existing = db.findMemoryByTag('semantic', matchTag);
  if (existing) {
    const existingItems = parseItemsWithCounts(existing.content);
    const incomingNames = parseListContent(content);

    if (incomingNames.every((name) => existingItems.some((e) => e.name === name))) return;

    const merged = new Map<string, number>();
    for (const item of existingItems) merged.set(item.name, item.count);
    for (const name of incomingNames) merged.set(name, (merged.get(name) ?? 0) + 1);

    const ranked = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEMANTIC_SINGLETON_CAP)
      .map(([name, count]) => ({ name, count }));

    const prefix = content.slice(0, content.indexOf(':') + 1);
    const mergedContent = `${prefix} ${formatItemsWithCounts(ranked)}`;

    db.updateMemory(existing.id, { content: mergedContent });

    const newEmb = await generateEmbedding(mergedContent);
    if (newEmb) {
      db.updateMemoryEmbedding(existing.id, newEmb);
    }
    return;
  }

  const incomingNames = parseListContent(content);
  const initial = incomingNames.map((name) => ({ name, count: 1 }));
  const prefix = content.slice(0, content.indexOf(':') + 1);
  const initialContent = `${prefix} ${formatItemsWithCounts(initial)}`;

  const emb = await generateEmbedding(initialContent);
  const record = makeMemoryRecord('semantic', initialContent, tags, { title, context: 'session-end auto-save' });
  if (emb) {
    record.embedding = embeddingToBuffer(emb);
  }
  db.insertMemory(record);
}

async function updateOrCreateProcedural(db: MemoryDatabase, content: string, category: BashCategory): Promise<void> {
  const existing = db.findMemoryByTag('procedural', category);
  if (existing) {
    const existingCmds = parseWorkflowCommands(existing.content);
    const incomingCmds = parseWorkflowCommands(content);
    if (incomingCmds.every((cmd) => existingCmds.includes(cmd))) return;
    const merged = [...new Set([...existingCmds, ...incomingCmds])];
    const mergedContent = `${categoryLabel(category)} workflow: ${merged.join(' && ')}`;
    db.updateMemory(existing.id, { content: mergedContent });
    const newEmb = await generateEmbedding(mergedContent);
    if (newEmb) {
      db.updateMemoryEmbedding(existing.id, newEmb);
    }
    return;
  }

  const emb = await generateEmbedding(content);
  const record = makeMemoryRecord('procedural', content, ['auto-procedural', category], {
    title: `${categoryLabel(category)} workflow`,
    context: 'session-end auto-save',
  });
  if (emb) {
    record.embedding = embeddingToBuffer(emb);
  }
  db.insertMemory(record);
}

function groupSuccessfulCommands(
  commands: { command: string; success: boolean; category: BashCategory }[],
): Map<BashCategory, string[]> {
  const grouped = new Map<BashCategory, string[]>();
  for (const cmd of commands) {
    if (!cmd.success || cmd.category === 'other' || cmd.category === 'git') continue;
    if (isTrivialCommand(cmd.command)) continue;
    const list = grouped.get(cmd.category) ?? [];
    if (!list.includes(cmd.command)) {
      list.push(cmd.command);
    }
    grouped.set(cmd.category, list);
  }
  return grouped;
}

function categoryLabel(category: BashCategory): string {
  const labels: Record<BashCategory, string> = {
    build: 'Build',
    test: 'Test',
    lint: 'Lint',
    format: 'Format',
    install: 'Install',
    deploy: 'Deploy',
    git: 'Git',
    other: 'Other',
  };
  return labels[category];
}

export function deriveEpisodicTitle(taskSummary: string, filesModified: string[]): string {
  // Use the task summary if it's meaningful (not an interruption marker or too short)
  if (taskSummary && taskSummary.length >= 10 && !taskSummary.startsWith('[Request interrupted')) {
    // Take first ~80 chars, break at word boundary
    const truncated = taskSummary.length <= 80 ? taskSummary : taskSummary.slice(0, 80).replace(/\s+\S*$/, '');
    return truncated;
  }

  // Fall back to deriving from modified files
  if (filesModified.length > 0) {
    const dirs = new Set<string>();
    for (const f of filesModified) {
      const parts = f.split('/');
      if (parts.length >= 2) {
        dirs.add(parts.slice(0, Math.min(2, parts.length - 1)).join('/'));
      } else {
        dirs.add(parts[0]);
      }
    }
    const dirList = [...dirs].slice(0, 3).join(', ');
    return `Session: ${filesModified.length} files in ${dirList}`;
  }

  return 'Session activity';
}

function extractActiveModules(filesModified: string[]): string[] {
  const dirCounts = new Map<string, number>();
  for (const f of filesModified) {
    const parts = f.split('/');
    if (parts.length >= 2) {
      const dir = parts.slice(0, Math.min(2, parts.length - 1)).join('/');
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
  }
  return [...dirCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([dir]) => dir);
}

function extractLastUserMessage(transcriptPath: string): string {
  if (!transcriptPath) return '';
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'user' && typeof entry.message?.content === 'string') {
          return entry.message.content as string;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

function extractLastAssistantMessage(transcriptPath: string): string {
  if (!transcriptPath) return '';
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant') {
          const parts = entry.message?.content ?? [];
          if (Array.isArray(parts)) {
            return parts
              .filter((p: { type: string }) => p.type === 'text')
              .map((p: { text: string }) => p.text)
              .join('\n');
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

