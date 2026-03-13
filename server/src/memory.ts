import { z } from 'zod';
import { ulid } from 'ulid';
import { statSync } from 'node:fs';
import type { MemoryDatabase, RelevanceFilterOptions } from './database.js';
import { generateEmbedding, generateEmbeddings, cosineSimilarity, isEmbeddingsAvailable } from './embeddings.js';
import { rerankResults, overfetchLimit, isRerankerAvailable } from './reranker.js';
import { rowToMemory, type Memory, type MemoryType, type RelationType } from './types.js';
import { splitByTopics, insertSplitSections } from './topic-splitter.js';
import { normalizeTags, buildMergeUpdates } from './merge-utils.js';
import { THRESHOLDS } from './thresholds.js';

export { buildMergeUpdates, normalizeTags, safeParseTags, type MergeInput } from './merge-utils.js';

const MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'working', 'pattern'] as const;
const RELATION_TYPES = ['relates_to', 'depends_on', 'contradicts', 'extends', 'implements', 'derived_from'] as const;

let backfillDone = false;

/** @internal Reset backfill state — used by tests only. */
export function resetBackfillFlag(): void {
  backfillDone = false;
}

export const memoryToolDefs = [
  {
    name: 'memory_store',
    description:
      "Store a new memory. Use 'episodic' for session events, 'semantic' for project facts, 'procedural' for how-to workflows, 'working' for in-session scratchpad (auto-cleared next session), 'pattern' for consolidated insights from multiple observations. IMPORTANT: Always write content and title in English, even if the user communicates in another language. This ensures consistent search and retrieval.",
    schema: {
      type: z
        .enum(MEMORY_TYPES)
        .describe(
          'Memory type: episodic (events), semantic (facts), procedural (how-to), working (scratchpad), pattern (consolidated insights)',
        ),
      content: z.string().describe('The memory content in markdown format. Must be in English.'),
      title: z.string().optional().describe('Optional title (recommended for pattern and semantic types)'),
      context: z.string().optional().describe('Optional context in which the memory was formed'),
      source: z.string().optional().describe('Optional provenance (file path, URL, session)'),
      tags: z.array(z.string()).optional().describe("Tags for categorization (e.g. ['auth', 'bug-fix'])"),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Importance score 0-1 (default 0.5, patterns default to 0.8)'),
    },
  },
  {
    name: 'memory_search',
    description:
      'Search memories using hybrid full-text + semantic search. Returns memories ranked by combined relevance, recency, importance, and access frequency.',
    schema: {
      query: z.string().describe('Search query - natural language works best for semantic matching'),
      type: z.enum(MEMORY_TYPES).optional().describe('Filter by memory type'),
      limit: z.number().optional().describe('Maximum results to return (default 20)'),
      strictness: z
        .enum(['low', 'normal', 'high'])
        .optional()
        .describe(
          'Relevance filtering: low=permissive, normal=default, high=strict — controls minimum relevance quality',
        ),
    },
  },
  {
    name: 'memory_list',
    description: 'List recent memories, optionally filtered by type.',
    schema: {
      type: z.enum(MEMORY_TYPES).optional().describe('Filter by memory type'),
      limit: z.number().optional().describe('Maximum results (default 20)'),
      offset: z.number().optional().describe('Pagination offset (default 0)'),
    },
  },
  {
    name: 'memory_get',
    description: 'Get a specific memory by its ID, including its relations.',
    schema: {
      id: z.string().describe('Memory ID (ULID)'),
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory by its ID.',
    schema: {
      id: z.string().describe('Memory ID (ULID)'),
    },
  },
  {
    name: 'memory_update',
    description: "Update an existing memory's content, title, context, source, tags, or importance.",
    schema: {
      id: z.string().describe('Memory ID (ULID)'),
      title: z.string().optional().describe('Updated title'),
      content: z.string().optional().describe('Updated content'),
      context: z.string().optional().describe('Updated context'),
      source: z.string().optional().describe('Updated source'),
      tags: z.array(z.string()).optional().describe('Updated tags'),
      importance: z.number().min(0).max(1).optional().describe('Updated importance score'),
    },
  },
  {
    name: 'memory_store_batch',
    description:
      'Store multiple memories at once. More efficient than calling memory_store repeatedly — generates embeddings in a single batch. IMPORTANT: All content and titles must be in English, even if the user communicates in another language.',
    schema: {
      memories: z
        .array(
          z.object({
            type: z.enum(MEMORY_TYPES),
            content: z.string(),
            title: z.string().optional(),
            context: z.string().optional(),
            source: z.string().optional(),
            tags: z.array(z.string()).optional(),
            importance: z.number().min(0).max(1).optional(),
          }),
        )
        .min(1)
        .max(50)
        .describe('Array of memories to store (max 50)'),
    },
  },
  {
    name: 'memory_relate',
    description: 'Create a relationship between two memories.',
    schema: {
      source_id: z.string().describe('Source memory ID'),
      target_id: z.string().describe('Target memory ID'),
      relation_type: z.enum(RELATION_TYPES).describe('Type of relationship'),
      weight: z.number().min(0).max(1).optional().describe('Relationship strength 0-1 (default 0.5)'),
    },
  },
  {
    name: 'memory_graph',
    description: 'Get a subgraph of related memories around a given memory.',
    schema: {
      id: z.string().describe('Center node memory ID'),
      depth: z.number().min(1).max(3).optional().describe('Levels of relations to traverse (default 1, max 3)'),
    },
  },
  {
    name: 'memory_health',
    description:
      'Health check for debugging the memory system. Returns memory counts, embedding coverage, staleness, age distribution, and session info.',
    schema: {},
  },
] as const;

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

export async function handleMemoryTool(
  db: MemoryDatabase,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (toolName) {
    case 'memory_store':
      return memoryStore(db, args);
    case 'memory_search':
      return memorySearch(db, args);
    case 'memory_list':
      return memoryList(db, args);
    case 'memory_get':
      return memoryGet(db, args);
    case 'memory_delete':
      return memoryDelete(db, args);
    case 'memory_update':
      return memoryUpdate(db, args);
    case 'memory_store_batch':
      return memoryStoreBatch(db, args);
    case 'memory_relate':
      return memoryRelate(db, args);
    case 'memory_graph':
      return memoryGraph(db, args);
    case 'memory_health':
      return memoryHealth(db);
    default:
      return text(`Unknown memory tool: ${toolName}`);
  }
}

async function backfillMissingEmbeddings(db: MemoryDatabase): Promise<void> {
  if (backfillDone) return;
  backfillDone = true;
  const ids = db.getMemoryIdsWithoutEmbedding();
  if (ids.length === 0) return;

  const BATCH_SIZE = 10;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const rows = batch.map((id) => db.getMemoryByIdRaw(id)).filter((r): r is NonNullable<typeof r> => r !== null);
    const texts = rows.map((r) => {
      const title = r.title ? `${r.title}\n\n` : '';
      return `${title}${r.content}`;
    });
    const embeddings = await generateEmbeddings(texts);
    for (let j = 0; j < rows.length; j++) {
      const emb = embeddings[j];
      if (emb) {
        db.updateMemoryEmbedding(rows[j].id, emb);
      }
    }
  }
}

async function memoryStore(db: MemoryDatabase, args: Record<string, unknown>): Promise<ToolResult> {
  const now = new Date().toISOString();
  const id = ulid();
  const tags = normalizeTags((args.tags as string[] | undefined) ?? []);
  const content = args.content as string;
  const title = (args.title as string | undefined) ?? null;
  const source = (args.source as string | undefined) ?? null;
  const memType = args.type as string;
  const defaultImportance = memType === 'pattern' ? 0.8 : 0.5;

  const embeddingText = title ? `${title}\n\n${content}` : content;
  const embedding = await generateEmbedding(embeddingText);

  const splitResult = splitByTopics(content, title ?? undefined);
  if (splitResult.shouldSplit) {
    const splitInsert = await insertSplitSections(db, splitResult.sections, {
      type: memType as MemoryType,
      context: (args.context as string | undefined) ?? null,
      source,
      tags,
      importance: (args.importance as number) ?? defaultImportance,
      detectContradictions: true,
    });
    const total = db.countMemories();
    return text(
      `Memory split into ${splitResult.sections.length} topic-specific memories (${splitInsert.mergedCount} merged, ${splitInsert.relationsCreated} relations created).\n\n**IDs:** ${splitInsert.insertedIds.join(', ')}\n**Total memories:** ${total}`,
    );
  }

  if (embedding) {
    const similar = db.findSimilarMemory(embedding, THRESHOLDS.EXACT_DUPLICATE, memType as MemoryType);
    if (similar) {
      const existing = db.getMemoryByIdRaw(similar.id);
      if (existing) {
        const updates = buildMergeUpdates(existing, {
          content,
          title,
          tags,
          context: (args.context as string | undefined) ?? null,
          source,
        });
        updates.importance = Math.min(1.0, existing.importance + 0.05);
        db.updateMemory(similar.id, updates);
        if (updates.content && updates.content !== existing.content) {
          db.updateMemoryEmbedding(similar.id, embedding);
        }
        return text(
          `Merged with existing memory ${similar.id} (${((1 - similar.distance) * 100).toFixed(1)}% match). Updated ${
            Object.keys(updates)
              .filter((k) => k !== 'importance')
              .join(', ') || 'importance'
          }.`,
        );
      }
    }
  }

  db.insertMemory({
    id,
    type: memType,
    title,
    content,
    context: (args.context as string) ?? null,
    source,
    tags: JSON.stringify(tags),
    importance: (args.importance as number) ?? defaultImportance,
    created_at: now,
    updated_at: now,
    access_count: 0,
    last_accessed: null,
  });

  let embeddingStatus = 'none';
  if (embedding) {
    db.updateMemoryEmbedding(id, embedding);
    embeddingStatus = 'generated';
  }

  let relatedNote = '';
  if (embedding) {
    const related = db.findRelatedMemories(embedding, 5);
    if (related.length > 0) {
      const contradictionLines: string[] = [];
      const otherLines: string[] = [];

      for (const c of related) {
        const mem = db.getMemoryByIdRaw(c.id);
        if (!mem) continue;
        const label = mem.title ?? mem.content.slice(0, 80);
        const similarity = ((1 - c.distance) * 100).toFixed(1);

        if (mem.type === memType) {
          const weight = parseFloat((1 - c.distance).toFixed(3));
          db.addRelation(id, mem.id, 'contradicts', weight);
          contradictionLines.push(`- → contradicts ${c.id} (${similarity}% similar): "${label}" [weight: ${weight}]`);
        } else {
          otherLines.push(`- ${c.id} (${similarity}% similar): ${label}`);
        }
      }

      if (contradictionLines.length > 0) {
        relatedNote += `\n\n**Potential contradictions auto-linked:**\n${contradictionLines.join('\n')}`;
      }
      if (otherLines.length > 0) {
        relatedNote += `\n\n**Other related memories (review manually):**\n${otherLines.join('\n')}`;
      }
    }
  }

  const total = db.countMemories();
  const titleInfo = title ? `\n**Title:** ${title}` : '';
  return text(
    `Memory stored successfully.\n\n**ID:** ${id}\n**Type:** ${memType}${titleInfo}\n**Tags:** ${tags.join(', ') || '(none)'}\n**Embedding:** ${embeddingStatus}\n**Total memories:** ${total}${relatedNote}`,
  );
}

const STRICTNESS_MAP: Record<string, RelevanceFilterOptions> = {
  low: { topicThreshold: 0.02, relevanceThreshold: 0 },
  normal: { topicThreshold: 0.05, relevanceThreshold: 0.1 },
  high: { topicThreshold: 0.15, relevanceThreshold: 0.2 },
};

async function memorySearch(db: MemoryDatabase, args: Record<string, unknown>): Promise<ToolResult> {
  // Backfill missing embeddings on first search
  await backfillMissingEmbeddings(db);

  const query = args.query as string;
  const type = args.type as MemoryType | undefined;
  const limit = (args.limit as number) ?? 20;
  const filter = STRICTNESS_MAP[(args.strictness as string) ?? 'normal'];

  const queryEmbedding = await generateEmbedding(query);

  // Over-fetch candidates for reranking
  let scored = db.hybridSearchMemories(query, queryEmbedding, overfetchLimit(limit), filter);

  // Type filter before reranking (don't waste cross-encoder on filtered-out results)
  if (type) {
    scored = scored.filter((r) => r.type === type);
  }

  if (scored.length === 0) {
    return text(`No memories found matching "${query}".`);
  }

  // Rerank with cross-encoder, then slice to final limit
  const { results, reranked } = await rerankResults(query, scored, limit);

  const formatted = results
    .map((row) => formatScoredMemory(rowToMemory(row), row.score, row.textScore))
    .join('\n---\n');

  const searchMode = queryEmbedding
    ? reranked
      ? 'hybrid (text + semantic + reranked)'
      : 'hybrid (text + semantic)'
    : 'text-only';
  return text(
    `Found ${results.length} memor${results.length === 1 ? 'y' : 'ies'} matching "${query}" [${searchMode}]:\n\n${formatted}`,
  );
}

function memoryList(db: MemoryDatabase, args: Record<string, unknown>): ToolResult {
  const type = args.type as MemoryType | undefined;
  const limit = (args.limit as number) ?? 20;
  const offset = (args.offset as number) ?? 0;

  const rows = db.listMemories(type, limit, offset);
  const total = db.countMemories(type);

  if (rows.length === 0) {
    return text(type ? `No ${type} memories found.` : 'No memories stored yet.');
  }

  const memories = rows.map(rowToMemory);
  const formatted = memories.map((m) => formatMemory(m)).join('\n---\n');

  return text(
    `Showing ${offset + 1}-${offset + memories.length} of ${total} memor${total === 1 ? 'y' : 'ies'}${type ? ` (type: ${type})` : ''}:\n\n${formatted}`,
  );
}

function memoryGet(db: MemoryDatabase, args: Record<string, unknown>): ToolResult {
  const id = args.id as string;
  const row = db.getMemoryById(id);
  if (!row) return text(`Memory ${id} not found.`);

  const memory = rowToMemory(row);
  const relations = db.getRelations(id);

  let result = formatMemory(memory);
  if (relations.length > 0) {
    result += '\n\n**Relations:**\n';
    for (const rel of relations) {
      const otherId = rel.source_id === id ? rel.target_id : rel.source_id;
      const direction = rel.source_id === id ? '->' : '<-';
      const otherRow = db.getMemoryByIdRaw(otherId);
      const otherLabel = otherRow?.title ?? otherRow?.content.slice(0, 50) ?? otherId;
      result += `- ${direction} ${rel.relation_type} (${rel.weight}): ${otherLabel} [${otherId}]\n`;
    }
  }

  return text(result);
}

function memoryDelete(db: MemoryDatabase, args: Record<string, unknown>): ToolResult {
  const id = args.id as string;
  const deleted = db.deleteMemory(id);
  return text(deleted ? `Memory ${id} deleted.` : `Memory ${id} not found.`);
}

async function memoryUpdate(db: MemoryDatabase, args: Record<string, unknown>): Promise<ToolResult> {
  const id = args.id as string;
  const updates: Record<string, unknown> = {};

  if (args.title !== undefined) updates.title = args.title;
  if (args.content !== undefined) updates.content = args.content;
  if (args.context !== undefined) updates.context = args.context;
  if (args.source !== undefined) updates.source = args.source;
  if (args.tags !== undefined) updates.tags = JSON.stringify(normalizeTags(args.tags as string[]));
  if (args.importance !== undefined) updates.importance = args.importance;

  const updated = db.updateMemory(id, updates);
  if (!updated) {
    return text(`Memory ${id} not found.`);
  }

  // Re-generate embedding if title or content changed
  if (args.title !== undefined || args.content !== undefined) {
    const title = updated.title ?? '';
    const content = updated.content;
    const embeddingText = title ? `${title}\n\n${content}` : content;
    const embedding = await generateEmbedding(embeddingText);
    if (embedding) {
      db.updateMemoryEmbedding(id, embedding);
    }
  }

  const memory = rowToMemory(updated);
  return text(`Memory updated:\n\n${formatMemory(memory)}`);
}

interface BatchMemoryInput {
  type: string;
  content: string;
  title?: string;
  context?: string;
  source?: string;
  tags?: string[];
  importance?: number;
}

async function memoryStoreBatch(db: MemoryDatabase, args: Record<string, unknown>): Promise<ToolResult> {
  const rawItems = args.memories as BatchMemoryInput[];
  const now = new Date().toISOString();

  const MAX_EXPANDED = 100;
  const items: BatchMemoryInput[] = [];
  const splitReport: string[] = [];
  const siblingGroups: { start: number; count: number }[] = [];

  for (const item of rawItems) {
    if (items.length >= MAX_EXPANDED) break;
    const split = splitByTopics(item.content, item.title);
    if (split.shouldSplit) {
      const start = items.length;
      for (const section of split.sections) {
        if (items.length >= MAX_EXPANDED) break;
        items.push({
          ...item,
          title: section.title,
          content: section.body,
        });
      }
      const actualCount = items.length - start;
      if (actualCount > 0) {
        siblingGroups.push({ start, count: actualCount });
        splitReport.push(`"${item.title ?? item.content.slice(0, 40)}..." → ${actualCount} sections`);
      }
    } else {
      items.push(item);
    }
  }

  const texts = items.map((m) => {
    const title = m.title ? `${m.title}\n\n` : '';
    return `${title}${m.content}`;
  });
  const embeddings = await generateEmbeddings(texts);

  const resolvedIds: string[] = [];
  const acceptedEmbeddings: { id: string; embedding: Float32Array }[] = [];
  let insertedCount = 0;
  let mergedCount = 0;
  let embeddingCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const emb = embeddings[i];
    const tags = normalizeTags(item.tags ?? []);

    // Dedup pass 1: within-batch
    if (emb) {
      const withinBatchDup = acceptedEmbeddings.find(
        (a) => 1 - cosineSimilarity(a.embedding, emb) < THRESHOLDS.EXACT_DUPLICATE,
      );
      if (withinBatchDup) {
        const existing = db.getMemoryByIdRaw(withinBatchDup.id);
        if (existing) {
          const updates = buildMergeUpdates(existing, {
            content: item.content,
            title: item.title,
            tags,
            context: item.context,
            source: item.source,
          });
          updates.importance = Math.min(1.0, existing.importance + 0.05);
          db.updateMemory(withinBatchDup.id, updates);
          if (updates.content && updates.content !== existing.content) {
            db.updateMemoryEmbedding(withinBatchDup.id, emb);
            const idx = acceptedEmbeddings.findIndex((a) => a.id === withinBatchDup.id);
            if (idx !== -1) acceptedEmbeddings[idx].embedding = emb;
          }
        }
        resolvedIds.push(withinBatchDup.id);
        mergedCount++;
        continue;
      }

      const dbDup = db.findSimilarMemory(emb, THRESHOLDS.EXACT_DUPLICATE, item.type as MemoryType);
      if (dbDup) {
        const existing = db.getMemoryByIdRaw(dbDup.id);
        if (existing) {
          const updates = buildMergeUpdates(existing, {
            content: item.content,
            title: item.title,
            tags,
            context: item.context,
            source: item.source,
          });
          updates.importance = Math.min(1.0, existing.importance + 0.05);
          db.updateMemory(dbDup.id, updates);
          if (updates.content && updates.content !== existing.content) {
            db.updateMemoryEmbedding(dbDup.id, emb);
          }
          resolvedIds.push(dbDup.id);
          mergedCount++;
          continue;
        }
      }
    }

    // No duplicate — insert
    const id = ulid();
    const defaultImportance = item.type === 'pattern' ? 0.8 : 0.5;

    db.insertMemory({
      id,
      type: item.type,
      title: item.title ?? null,
      content: item.content,
      context: item.context ?? null,
      source: item.source ?? null,
      tags: JSON.stringify(tags),
      importance: item.importance ?? defaultImportance,
      created_at: now,
      updated_at: now,
      access_count: 0,
      last_accessed: null,
    });

    if (emb) {
      db.updateMemoryEmbedding(id, emb);
      acceptedEmbeddings.push({ id, embedding: emb });
      embeddingCount++;
    }

    resolvedIds.push(id);
    insertedCount++;
  }

  let relationsCreated = 0;
  for (const group of siblingGroups) {
    const ids = resolvedIds.slice(group.start, group.start + group.count);
    const useChain = ids.length > 5;

    if (useChain) {
      for (let i = 0; i < ids.length - 1; i++) {
        try {
          db.addRelation(ids[i], ids[i + 1], 'relates_to' as RelationType, 0.8);
          relationsCreated++;
        } catch {
          // Relation already exists
        }
      }
    } else {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          try {
            db.addRelation(ids[i], ids[j], 'relates_to' as RelationType, 0.8);
            relationsCreated++;
          } catch {
            // Relation already exists
          }
        }
      }
    }
  }

  const total = db.countMemories();
  const splitNote = splitReport.length > 0 ? `\n**Split:** ${splitReport.join('; ')}` : '';
  const relNote = relationsCreated > 0 ? `\n**Relations:** ${relationsCreated} sibling relations created` : '';
  return text(
    `Batch stored ${insertedCount} new, ${mergedCount} merged (${embeddingCount} with embeddings).${splitNote}${relNote}\n\n**IDs:** ${resolvedIds.join(', ')}\n**Total memories:** ${total}`,
  );
}

function memoryRelate(db: MemoryDatabase, args: Record<string, unknown>): ToolResult {
  const sourceId = args.source_id as string;
  const targetId = args.target_id as string;
  const relationType = args.relation_type as RelationType;
  const weight = (args.weight as number) ?? 0.5;

  const source = db.getMemoryByIdRaw(sourceId);
  const target = db.getMemoryByIdRaw(targetId);

  if (!source) return text(`Source memory ${sourceId} not found.`);
  if (!target) return text(`Target memory ${targetId} not found.`);

  db.addRelation(sourceId, targetId, relationType, weight);

  const sourceLabel = source.title ?? source.content.slice(0, 50);
  const targetLabel = target.title ?? target.content.slice(0, 50);
  return text(`Relation created: "${sourceLabel}" --[${relationType} (${weight})]--> "${targetLabel}"`);
}

function memoryGraph(db: MemoryDatabase, args: Record<string, unknown>): ToolResult {
  const id = args.id as string;
  const depth = (args.depth as number) ?? 1;

  const center = db.getMemoryByIdRaw(id);
  if (!center) return text(`Memory ${id} not found.`);

  const graph = db.getGraph(id, depth);
  const centerLabel = center.title ?? center.content.slice(0, 50);

  if (graph.relations.length === 0) {
    return text(`Memory "${centerLabel}" has no relations.\n\n${formatMemory(rowToMemory(center))}`);
  }

  let result = `Memory graph around "${centerLabel}" (depth: ${depth}):\n\n`;
  result += `**Nodes (${graph.nodes.length}):**\n`;
  for (const node of graph.nodes) {
    const m = rowToMemory(node);
    const label = m.title ?? m.content.slice(0, 50);
    const marker = node.id === id ? ' (center)' : '';
    result += `- [${m.type}] ${label} [${m.id}]${marker}\n`;
  }

  result += `\n**Relations (${graph.relations.length}):**\n`;
  for (const rel of graph.relations) {
    const sourceRow = graph.nodes.find((n) => n.id === rel.source_id);
    const targetRow = graph.nodes.find((n) => n.id === rel.target_id);
    const sourceLabel = sourceRow?.title ?? sourceRow?.content.slice(0, 50) ?? rel.source_id;
    const targetLabel = targetRow?.title ?? targetRow?.content.slice(0, 50) ?? rel.target_id;
    result += `- "${sourceLabel}" --[${rel.relation_type} (${rel.weight})]--> "${targetLabel}"\n`;
  }

  return text(result);
}

async function memoryHealth(db: MemoryDatabase): Promise<ToolResult> {
  const stats = db.getHealthStats();
  const embAvailable = await isEmbeddingsAvailable();
  const rerankerAvailable = await isRerankerAvailable();

  let fileSize = 'unknown';
  try {
    const st = statSync(db.path);
    const mb = (st.size / (1024 * 1024)).toFixed(2);
    fileSize = `${mb} MB`;
  } catch {
    // DB path may not be accessible
  }

  const typeLines = Object.entries(stats.byType)
    .map(([type, count]) => `  - ${type}: ${count}`)
    .join('\n');

  const report = `# Memory Health Report

**Database:** ${fileSize}
**Embeddings model:** ${embAvailable ? 'available' : 'unavailable'}
**Reranker model:** ${rerankerAvailable ? 'available' : 'unavailable'}

## Counts
- **Total:** ${stats.total}
${typeLines}

## Embedding Coverage
- **With embedding:** ${stats.withEmbedding}
- **Without embedding:** ${stats.withoutEmbedding}
- **Coverage:** ${stats.total > 0 ? ((stats.withEmbedding / stats.total) * 100).toFixed(1) : '0'}%

## Staleness
- **Stale memories** (importance < 0.2, access < 2, older than 30d): ${stats.staleCount}

## Age Distribution
- Last 24h: ${stats.ageDistribution.last24h}
- Last 7d: ${stats.ageDistribution.last7d}
- Last 30d: ${stats.ageDistribution.last30d}
- Older: ${stats.ageDistribution.older}

## Session Info
- **Session count:** ${stats.sessionCount}
- **Last consolidation:** session #${stats.lastConsolidation}
- **Sessions since consolidation:** ${stats.sessionCount - stats.lastConsolidation}`;

  return text(report);
}

function formatMemory(m: Memory): string {
  const titleLine = m.title ? ` — ${m.title}` : '';
  const sourceLine = m.source ? ` | **Source:** ${m.source}` : '';
  return `**[${m.type}]** ${m.id}${titleLine}
**Importance:** ${m.importance} | **Accessed:** ${m.access_count}x | **Created:** ${m.created_at.slice(0, 10)}
**Tags:** ${m.tags.length > 0 ? m.tags.join(', ') : '(none)'}${sourceLine}
${m.context ? `**Context:** ${m.context}\n` : ''}
${m.content}`;
}

function formatScoredMemory(m: Memory, score: number, textScore?: number): string {
  const titleLine = m.title ? ` — ${m.title}` : '';
  const sourceLine = m.source ? ` | **Source:** ${m.source}` : '';
  const scoreInfo =
    textScore !== undefined
      ? `score: ${score.toFixed(3)} (text: ${textScore.toFixed(3)})`
      : `score: ${score.toFixed(3)}`;
  return `**[${m.type}]** ${m.id}${titleLine} — ${scoreInfo}
**Importance:** ${m.importance} | **Accessed:** ${m.access_count}x | **Created:** ${m.created_at.slice(0, 10)}
**Tags:** ${m.tags.length > 0 ? m.tags.join(', ') : '(none)'}${sourceLine}
${m.context ? `**Context:** ${m.context}\n` : ''}
${m.content}`;
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}
