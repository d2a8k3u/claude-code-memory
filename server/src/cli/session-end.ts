import type { MemoryDatabase } from '../database.js';
import type { MemoryRow, MemoryType } from '../types.js';
import { generateEmbedding, generateEmbeddings, embeddingToBuffer, cosineSimilarity, bufferToEmbedding } from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { parseTranscript, type BashCategory } from './transcript.js';
import { makeMemoryRecord, derivePatternTitle } from './shared.js';
import { safeParseTags } from '../merge-utils.js';

export async function handleSessionEnd(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const summary = parseTranscript(input.transcript_path ?? '', cwd);

  const episodicRecords: (MemoryRow & { embedding?: Buffer | null })[] = [];
  const embeddingTexts: string[] = [];

  const mainParts: string[] = [];
  const taskSummary = summary.taskSummary ?? '';
  if (taskSummary) mainParts.push(`**Task:** ${taskSummary}`);
  if (summary.toolsUsed.length > 0) mainParts.push(`**Tools:** ${summary.toolsUsed.join(', ')}`);
  if (summary.memorySearches > 0 || summary.memoryStores > 0) {
    mainParts.push(`**Memory ops:** ${summary.memorySearches} searches, ${summary.memoryStores} stores`);
  }

  if (mainParts.length === 0 && summary.filesModified.length === 0 && summary.errorCount === 0) {
    return { ok: true };
  }

  // Step 2: Filter meaningless episodic records
  const isMeaningless =
    taskSummary.length < 15 || taskSummary.startsWith('[Request interrupted');
  const hasSubstance =
    summary.toolsUsed.length > 0 ||
    summary.memorySearches > 0 ||
    summary.memoryStores > 0;

  if (mainParts.length > 0 && !(isMeaningless && !hasSubstance)) {
    const mainContent = mainParts.join('\n');
    episodicRecords.push(makeMemoryRecord('episodic', mainContent, ['auto-save', 'session-end']));
    embeddingTexts.push(mainContent);
  }

  if (summary.filesModified.length > 0) {
    const filesContent = `**Files modified:** ${summary.filesModified.join(', ')}`;
    episodicRecords.push(makeMemoryRecord('episodic', filesContent, ['auto-save', 'session-files']));
    embeddingTexts.push(filesContent);
  }

  if (summary.errorCount > 0) {
    const taskContext = taskSummary ? ` during: ${taskSummary}` : '';
    const errorsContent = `**Errors encountered:** ${summary.errorCount} errors during session${taskContext}`;
    episodicRecords.push(makeMemoryRecord('episodic', errorsContent, ['auto-save', 'session-errors']));
    embeddingTexts.push(errorsContent);
  }

  // Handle singleton records by tag-based lookup (one per category, updated in place)
  const successfulByCategory = groupSuccessfulCommands(summary.bashCommands);

  for (const [category, commands] of successfulByCategory) {
    if (commands.length < 2) continue;
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
      const similar = db.findSimilarMemory(emb, 0.10, record.type as MemoryType);
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
    const existingItems = parseListContent(existing.content);
    const incomingItems = parseListContent(content);
    const merged = [...new Set([...existingItems, ...incomingItems])].sort();

    const prefix = content.slice(0, content.indexOf(':') + 1);
    const mergedContent = `${prefix} ${merged.join(', ')}`;

    db.updateMemory(existing.id, { content: mergedContent });

    const newEmb = await generateEmbedding(mergedContent);
    if (newEmb) {
      db.updateMemoryEmbedding(existing.id, newEmb);
    }
    return;
  }

  const emb = await generateEmbedding(content);
  const record = makeMemoryRecord('semantic', content, tags, { title, context: 'session-end auto-save' });
  if (emb) {
    record.embedding = embeddingToBuffer(emb);
  }
  db.insertMemory(record);
}

async function updateOrCreateProcedural(
  db: MemoryDatabase,
  content: string,
  category: BashCategory,
): Promise<void> {
  const existing = db.findMemoryByTag('procedural', category);
  if (existing) {
    db.updateMemory(existing.id, { content });
    const newEmb = await generateEmbedding(content);
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
      if (similarity >= 0.4 && similarity <= 0.95) {
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
  const patternData: { memberIds: string[]; clusterIdx: number }[] = [];

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];

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
      const sim = cosineSimilarity(centroid, patEmb);
      if (sim > 0.5) {
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
    });
  }

  if (patternTexts.length === 0) return;

  const patternEmbeddings = await generateEmbeddings(patternTexts);

  for (let i = 0; i < patternData.length; i++) {
    const emb = patternEmbeddings[i];
    if (!emb) continue;

    const similar = db.findSimilarMemory(emb, 0.05);
    if (similar) continue;

    const taskDescriptions = patternData[i].memberIds
      .map((id) => {
        const mem = clusterCandidates.find((e) => e.id === id);
        return mem ? extractTaskFromEpisodic(mem.content) : '';
      })
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

    for (const memberId of patternData[i].memberIds) {
      try {
        db.addRelation(record.id, memberId, 'derived_from', 0.7);
      } catch {
        // Relation insert failed
      }
    }
  }
}
