import type { MemoryDatabase } from '../database.js';
import type { MemoryRow, MemoryType } from '../types.js';
import { generateEmbedding, generateEmbeddings, embeddingToBuffer } from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { parseTranscript, type BashCategory, type TranscriptSummary } from './transcript.js';
import { makeMemoryRecord } from './shared.js';
import { safeParseTags } from '../merge-utils.js';
import { THRESHOLDS } from '../thresholds.js';
import { splitByTopics, insertSplitSections } from '../topic-splitter.js';
import { detectAndStorePatterns } from './pattern-detector.js';

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

  const episodicRecords: (MemoryRow & { embedding?: Buffer | null })[] = [];
  const embeddingTexts: string[] = [];

  // Build unified episodic record (files + errors merged into main)
  const mainParts: string[] = [];
  const taskSummary = summary.taskSummary ?? '';
  if (taskSummary) mainParts.push(`**Task:** ${taskSummary}`);
  if (summary.toolsUsed.length > 0) mainParts.push(`**Tools:** ${summary.toolsUsed.join(', ')}`);
  if (summary.memorySearches > 0 || summary.memoryStores > 0) {
    mainParts.push(`**Memory ops:** ${summary.memorySearches} searches, ${summary.memoryStores} stores`);
  }
  if (summary.filesModified.length > 0) {
    mainParts.push(`**Files modified:** ${summary.filesModified.join(', ')}`);
  }
  if (summary.errorCount > 0) {
    mainParts.push(`**Errors:** ${summary.errorCount} errors during session`);
  }

  if (mainParts.length === 0) {
    return { ok: true };
  }

  const isInterrupted = taskSummary.startsWith('[Request interrupted');
  const isShortTask = taskSummary.length < 30;
  const substanceScore = computeSubstanceScore(summary);
  const hasSubstance = substanceScore >= SUBSTANCE_THRESHOLD;
  const isTrivial = summary.toolCallCount < 3 && summary.filesModified.length === 0;

  if (!isInterrupted && !(isShortTask && (!hasSubstance || isTrivial))) {
    const mainContent = mainParts.join('\n');
    episodicRecords.push(makeMemoryRecord('episodic', mainContent, ['auto-save', 'session-end']));
    embeddingTexts.push(mainContent);
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
    const emb = embeddings[i];

    if (emb) {
      const similar = db.findSimilarMemory(emb, THRESHOLDS.EPISODIC_DEDUP, record.type as MemoryType);
      if (similar) continue;
    }

    const splitResult = splitByTopics(record.content);
    if (splitResult.shouldSplit && splitResult.sections) {
      await insertSplitSections(db, splitResult.sections, {
        type: record.type as MemoryType,
        context: record.context ?? undefined,
        tags: safeParseTags(record.tags),
      });
    } else {
      db.insertMemory(record);
    }
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

