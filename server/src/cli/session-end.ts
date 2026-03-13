import type { MemoryDatabase } from '../database.js';
import type { MemoryRow, MemoryType } from '../types.js';
import {
  generateEmbedding,
  generateEmbeddings,
  embeddingToBuffer,
  cosineSimilarity,
  bufferToEmbedding,
} from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { parseTranscript, type BashCategory, type TranscriptSummary } from './transcript.js';
import { makeMemoryRecord, derivePatternTitle } from './shared.js';
import { safeParseTags } from '../merge-utils.js';
import { THRESHOLDS } from '../thresholds.js';

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

    db.insertMemory(record);
  }

  await detectAndCreatePatterns(db);

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

function extractTaskFromEpisodic(content: string): string {
  const taskMatch = content.match(/\*\*Task:\*\*\s*(.+?)(?:\n|$)/);
  return taskMatch ? taskMatch[1].trim() : content.slice(0, 100);
}

async function detectAndCreatePatterns(db: MemoryDatabase): Promise<void> {
  const recentEpisodics = db.getRecentEpisodicWithEmbeddings(30, 50);

  const clusterCandidates = recentEpisodics.filter((mem) => {
    const tags = safeParseTags(mem.tags);
    if (!tags.includes('session-end')) return false;
    if (mem.content.includes('[Request interrupted')) return false;
    return true;
  });
  if (clusterCandidates.length < 3) return;

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

    if (cluster.length >= 3) {
      clusters.push(cluster);
    }
  }

  if (clusters.length === 0) return;

  const patternTexts: string[] = [];
  const patternData: { memberIds: string[]; clusterIdx: number; quality: number }[] = [];

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];
    const clusterEmbs = cluster.map((idx) => bufferToEmbedding(clusterCandidates[idx].embedding));

    let pairSum = 0;
    let pairCount = 0;
    for (let a = 0; a < clusterEmbs.length; a++) {
      for (let b = a + 1; b < clusterEmbs.length; b++) {
        pairSum += cosineSimilarity(clusterEmbs[a], clusterEmbs[b]);
        pairCount++;
      }
    }
    const avgSimilarity = pairCount > 0 ? pairSum / pairCount : 0;
    if (avgSimilarity < THRESHOLDS.CLUSTER_QUALITY_MIN) continue;

    const dim = 384;
    const centroid = new Float32Array(dim);
    for (const emb of clusterEmbs) {
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
      const sim = cosineSimilarity(centroid, patEmb);
      if (sim > THRESHOLDS.PATTERN_OVERLAP) {
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
    patternData.push({
      memberIds: cluster.map((idx) => clusterCandidates[idx].id),
      clusterIdx: ci,
      quality: avgSimilarity,
    });
  }

  if (patternTexts.length === 0) return;

  const patternEmbeddings = await generateEmbeddings(patternTexts);

  for (let i = 0; i < patternData.length; i++) {
    const emb = patternEmbeddings[i];
    if (!emb) continue;

    const similar = db.findSimilarMemory(emb, THRESHOLDS.EXACT_DUPLICATE);
    if (similar) continue;

    const taskDescriptions = patternData[i].memberIds
      .map((id) => {
        const mem = clusterCandidates.find((e) => e.id === id);
        return mem ? extractTaskFromEpisodic(mem.content) : '';
      })
      .filter((t) => t.length > 0);
    const title = derivePatternTitle(taskDescriptions);
    const content = patternTexts[i].slice(patternTexts[i].indexOf(':') + 2);

    const importance = patternData[i].quality >= THRESHOLDS.CLUSTER_QUALITY_STRONG ? 0.8 : 0.6;
    const record = makeMemoryRecord('pattern', content, ['auto-pattern'], {
      title,
      importance,
      context: 'auto-consolidation',
    });
    record.embedding = embeddingToBuffer(emb);
    db.insertMemory(record);

    for (const memberId of patternData[i].memberIds) {
      try {
        db.addRelation(record.id, memberId, 'derived_from', 0.7);
      } catch {
        // Relation insert failed
      }
    }
  }
}
