import type { MemoryDatabase } from '../database.js';
import {
  generateEmbeddings,
  embeddingToBuffer,
  bufferToEmbedding,
  cosineSimilarity,
} from '../embeddings.js';
import { makeMemoryRecord, derivePatternTitle } from './shared.js';
import { safeParseTags } from '../merge-utils.js';
import { THRESHOLDS } from '../thresholds.js';

export function extractTaskFromEpisodic(content: string): string {
  const taskMatch = content.match(/\*\*Task:\*\*\s*(.+?)(?:\n|$)/);
  return taskMatch ? taskMatch[1].trim() : content.slice(0, 100);
}

export function deduplicateTaskDescriptions(tasks: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const task of tasks) {
    const normalized = task.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(task);
    }
  }
  return unique;
}

/**
 * Detect pattern clusters from recent episodic memories and store them.
 * Shared by both session-start (autoConsolidate) and session-end hooks.
 * Returns count of patterns created.
 */
export async function detectAndStorePatterns(db: MemoryDatabase): Promise<number> {
  const recentEpisodics = db.getRecentEpisodicWithEmbeddings(30, 50);

  const clusterCandidates = recentEpisodics.filter((mem) => {
    const tags = safeParseTags(mem.tags);
    if (!tags.includes('session-end')) return false;
    if (mem.content.includes('[Request interrupted')) return false;
    return true;
  });
  if (clusterCandidates.length < 3) return 0;

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

  if (clusters.length === 0) return 0;

  const patternTexts: string[] = [];
  const patternData: { memberIds: string[]; quality: number; content: string }[] = [];

  for (const cluster of clusters) {
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
      if (cosineSimilarity(centroid, patEmb) > THRESHOLDS.PATTERN_OVERLAP) {
        covered = true;
        break;
      }
    }
    if (covered) continue;

    const taskDescriptions = cluster
      .map((idx) => extractTaskFromEpisodic(clusterCandidates[idx].content))
      .filter((t) => t.length > 0);
    const title = derivePatternTitle(taskDescriptions);
    const uniqueTasks = deduplicateTaskDescriptions(taskDescriptions);
    const content = `Recurring theme across ${cluster.length} sessions.\n\n**Representative tasks:**\n${uniqueTasks.map((t) => `- ${t}`).join('\n')}`;

    patternTexts.push(`${title}: ${content}`);
    patternData.push({
      memberIds: cluster.map((idx) => clusterCandidates[idx].id),
      quality: avgSimilarity,
      content,
    });
  }

  if (patternTexts.length === 0) return 0;

  let patternsCreated = 0;
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
    const content = patternData[i].content;

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
        // Relation insert failed — not critical
      }
    }
    patternsCreated++;
  }

  return patternsCreated;
}
