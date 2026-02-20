import { z } from 'zod';
import { ulid } from 'ulid';
import type { MemoryDatabase } from './database.js';
import { generateEmbedding, generateEmbeddings } from './embeddings.js';
import { rowToMemory, type Memory, type MemoryType, type RelationType } from './types.js';

const MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'working', 'pattern'] as const;
const RELATION_TYPES = ['relates_to', 'depends_on', 'contradicts', 'extends', 'implements', 'derived_from'] as const;

let backfillDone = false;

/** @internal Reset backfill state — used by tests only. */
export function resetBackfillFlag(): void {
  backfillDone = false;
}

function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter((t) => t.length > 0 && t.length <= 50),
    ),
  ];
}

export const memoryToolDefs = [
  {
    name: 'memory_store',
    description:
      "Store a new memory. Use 'episodic' for session events, 'semantic' for project facts, 'procedural' for how-to workflows, 'working' for in-session scratchpad (auto-cleared next session), 'pattern' for consolidated insights from multiple observations.",
    schema: {
      type: z
        .enum(MEMORY_TYPES)
        .describe(
          'Memory type: episodic (events), semantic (facts), procedural (how-to), working (scratchpad), pattern (consolidated insights)',
        ),
      content: z.string().describe('The memory content in markdown format'),
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
      'Store multiple memories at once. More efficient than calling memory_store repeatedly — generates embeddings in a single batch.',
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
    const rows = batch.map((id) => db.getMemoryById(id)).filter((r): r is NonNullable<typeof r> => r !== null);
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

  // Auto-merge: if near-duplicate exists (distance < 0.03), merge instead of creating
  let dupWarning = '';
  if (embedding) {
    const similar = db.findSimilarMemory(embedding, 0.05);
    if (similar && similar.distance < 0.03) {
      const existing = db.getMemoryById(similar.id);
      if (existing) {
        const updates: Record<string, unknown> = {};
        if (content.length > existing.content.length) {
          updates.content = content;
        }
        if (title && !existing.title) {
          updates.title = title;
        }
        if (Object.keys(updates).length > 0) {
          db.updateMemory(similar.id, updates);
          if (updates.content) {
            db.updateMemoryEmbedding(similar.id, embedding);
          }
        }
        return text(
          `Merged with existing memory ${similar.id} (${((1 - similar.distance) * 100).toFixed(1)}% match). Updated ${Object.keys(updates).length > 0 ? Object.keys(updates).join(', ') : 'access count'}.`,
        );
      }
    }

    // Warn about similar but distinct
    if (similar && similar.distance >= 0.03 && similar.distance < 0.05) {
      const similarity = ((1 - similar.distance) * 100).toFixed(1);
      dupWarning = `\n**Warning:** Similar memory exists (${similarity}% match): ${similar.id}`;
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

  const total = db.countMemories();
  const titleInfo = title ? `\n**Title:** ${title}` : '';
  return text(
    `Memory stored successfully.\n\n**ID:** ${id}\n**Type:** ${memType}${titleInfo}\n**Tags:** ${tags.join(', ') || '(none)'}\n**Embedding:** ${embeddingStatus}\n**Total memories:** ${total}${dupWarning}`,
  );
}

async function memorySearch(db: MemoryDatabase, args: Record<string, unknown>): Promise<ToolResult> {
  // Backfill missing embeddings on first search
  await backfillMissingEmbeddings(db);

  const query = args.query as string;
  const type = args.type as MemoryType | undefined;
  const limit = (args.limit as number) ?? 20;

  const queryEmbedding = await generateEmbedding(query);

  let scored = db.hybridSearchMemories(query, queryEmbedding, limit);

  if (type) {
    scored = scored.filter((r) => r.type === type);
  }

  if (scored.length === 0) {
    return text(`No memories found matching "${query}".`);
  }

  const formatted = scored.map((row) => formatScoredMemory(rowToMemory(row), row.score)).join('\n---\n');

  const searchMode = queryEmbedding ? 'hybrid (text + semantic)' : 'text-only';
  return text(
    `Found ${scored.length} memor${scored.length === 1 ? 'y' : 'ies'} matching "${query}" [${searchMode}]:\n\n${formatted}`,
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
      const otherRow = db.getMemoryById(otherId);
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
  const items = args.memories as BatchMemoryInput[];
  const now = new Date().toISOString();

  const texts = items.map((m) => {
    const title = m.title ? `${m.title}\n\n` : '';
    return `${title}${m.content}`;
  });
  const embeddings = await generateEmbeddings(texts);

  const ids: string[] = [];
  let embeddingCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = ulid();
    ids.push(id);
    const tags = normalizeTags(item.tags ?? []);
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

    const emb = embeddings[i];
    if (emb) {
      db.updateMemoryEmbedding(id, emb);
      embeddingCount++;
    }
  }

  const total = db.countMemories();
  return text(
    `Batch stored ${items.length} memories (${embeddingCount} with embeddings).\n\n**IDs:** ${ids.join(', ')}\n**Total memories:** ${total}`,
  );
}

function memoryRelate(db: MemoryDatabase, args: Record<string, unknown>): ToolResult {
  const sourceId = args.source_id as string;
  const targetId = args.target_id as string;
  const relationType = args.relation_type as RelationType;
  const weight = (args.weight as number) ?? 0.5;

  const source = db.getMemoryById(sourceId);
  const target = db.getMemoryById(targetId);

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

  const center = db.getMemoryById(id);
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

function formatMemory(m: Memory): string {
  const titleLine = m.title ? ` — ${m.title}` : '';
  const sourceLine = m.source ? ` | **Source:** ${m.source}` : '';
  return `**[${m.type}]** ${m.id}${titleLine}
**Importance:** ${m.importance} | **Accessed:** ${m.access_count}x | **Created:** ${m.created_at.slice(0, 10)}
**Tags:** ${m.tags.length > 0 ? m.tags.join(', ') : '(none)'}${sourceLine}
${m.context ? `**Context:** ${m.context}\n` : ''}
${m.content}`;
}

function formatScoredMemory(m: Memory, score: number): string {
  const titleLine = m.title ? ` — ${m.title}` : '';
  const sourceLine = m.source ? ` | **Source:** ${m.source}` : '';
  return `**[${m.type}]** ${m.id}${titleLine} — score: ${score.toFixed(3)}
**Importance:** ${m.importance} | **Accessed:** ${m.access_count}x | **Created:** ${m.created_at.slice(0, 10)}
**Tags:** ${m.tags.length > 0 ? m.tags.join(', ') : '(none)'}${sourceLine}
${m.context ? `**Context:** ${m.context}\n` : ''}
${m.content}`;
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}
