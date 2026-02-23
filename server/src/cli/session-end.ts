import type { MemoryDatabase } from '../database.js';
import type { MemoryRow } from '../types.js';
import { generateEmbeddings, embeddingToBuffer, cosineSimilarity, bufferToEmbedding } from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { parseTranscript, type BashCategory } from './transcript.js';
import { makeMemoryRecord, derivePatternTitle } from './shared.js';

export async function handleSessionEnd(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const summary = parseTranscript(input.transcript_path ?? '', cwd);

  const episodicRecords: (MemoryRow & { embedding?: Buffer | null })[] = [];
  const embeddingTexts: string[] = [];

  const mainParts: string[] = [];
  if (summary.taskSummary) mainParts.push(`**Task:** ${summary.taskSummary}`);
  if (summary.toolsUsed.length > 0) mainParts.push(`**Tools:** ${summary.toolsUsed.join(', ')}`);
  if (summary.memorySearches > 0 || summary.memoryStores > 0) {
    mainParts.push(`**Memory ops:** ${summary.memorySearches} searches, ${summary.memoryStores} stores`);
  }

  if (mainParts.length === 0 && summary.filesModified.length === 0 && summary.errorCount === 0) {
    return { ok: true };
  }

  if (mainParts.length > 0) {
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
    const taskContext = summary.taskSummary ? ` during: ${summary.taskSummary}` : '';
    const errorsContent = `**Errors encountered:** ${summary.errorCount} errors during session${taskContext}`;
    episodicRecords.push(makeMemoryRecord('episodic', errorsContent, ['auto-save', 'session-errors']));
    embeddingTexts.push(errorsContent);
  }

  const proceduralRecords: (MemoryRow & { embedding?: Buffer | null })[] = [];
  const successfulByCategory = groupSuccessfulCommands(summary.bashCommands);

  for (const [category, commands] of successfulByCategory) {
    if (commands.length < 2) continue;
    const content = `${categoryLabel(category)} workflow: ${commands.join(' && ')}`;
    proceduralRecords.push(
      makeMemoryRecord('procedural', content, ['auto-procedural', category], {
        title: `${categoryLabel(category)} workflow`,
        context: 'session-end auto-save',
      }),
    );
    embeddingTexts.push(content);
  }

  const semanticRecords: (MemoryRow & { embedding?: Buffer | null })[] = [];

  if (summary.technologies.length > 0) {
    const techContent = `Technology stack used: ${summary.technologies.join(', ')}`;
    semanticRecords.push(
      makeMemoryRecord('semantic', techContent, ['auto-semantic', 'tech-stack'], {
        title: 'Technology stack',
        context: 'session-end auto-save',
      }),
    );
    embeddingTexts.push(techContent);
  }

  const activeModules = extractActiveModules(summary.filesModified);
  if (activeModules.length > 0) {
    const moduleContent = `Active modules/directories: ${activeModules.join(', ')}`;
    semanticRecords.push(
      makeMemoryRecord('semantic', moduleContent, ['auto-semantic', 'active-modules'], {
        title: 'Active modules',
        context: 'session-end auto-save',
      }),
    );
    embeddingTexts.push(moduleContent);
  }

  const allRecords = [...episodicRecords, ...proceduralRecords, ...semanticRecords];
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

    if (record.type !== 'episodic' && emb) {
      const similar = db.findSimilarMemory(emb, 0.05);
      if (similar) continue;
    }

    db.insertMemory(record);
  }

  await detectAndCreatePatterns(db);

  return { ok: true };
}

function groupSuccessfulCommands(
  commands: { command: string; success: boolean; category: BashCategory }[],
): Map<BashCategory, string[]> {
  const grouped = new Map<BashCategory, string[]>();
  for (const cmd of commands) {
    if (!cmd.success || cmd.category === 'other' || cmd.category === 'git') continue;
    const list = grouped.get(cmd.category) ?? [];
    list.push(cmd.command);
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

async function detectAndCreatePatterns(db: MemoryDatabase): Promise<void> {
  const recentEpisodics = db.getRecentEpisodicWithEmbeddings(30, 50);
  if (recentEpisodics.length < 3) return;

  const existingPatterns = db.getMemoriesByTypeWithEmbeddings('pattern', 20);

  const clusters: number[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < recentEpisodics.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [i];
    assigned.add(i);

    const embI = bufferToEmbedding(recentEpisodics[i].embedding);
    for (let j = i + 1; j < recentEpisodics.length; j++) {
      if (assigned.has(j)) continue;
      const embJ = bufferToEmbedding(recentEpisodics[j].embedding);
      const similarity = cosineSimilarity(embI, embJ);
      // MiniLM-L6-v2 produces ~0.40-0.65 for related sentences, >0.95 for near-duplicates
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
    const memberTexts = cluster.map((idx) => recentEpisodics[idx].content);

    const dim = 384;
    const centroid = new Float32Array(dim);
    for (const idx of cluster) {
      const emb = bufferToEmbedding(recentEpisodics[idx].embedding);
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

    const title = derivePatternTitle(memberTexts);
    const content = `Recurring theme across ${cluster.length} sessions: ${memberTexts.join(' | ')}`;

    patternTexts.push(`${title}: ${content}`);
    patternData.push({
      memberIds: cluster.map((idx) => recentEpisodics[idx].id),
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

    const title = derivePatternTitle(
      patternData[i].memberIds.map((id) => recentEpisodics.find((e) => e.id === id)?.content ?? ''),
    );
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
