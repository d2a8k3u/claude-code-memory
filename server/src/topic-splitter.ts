import { ulid } from 'ulid';
import type { MemoryDatabase } from './database.js';
import type { MemoryRow, MemoryType, RelationType } from './types.js';
import { generateEmbeddings } from './embeddings.js';
import { buildMergeUpdates, normalizeTags } from './merge-utils.js';
import { THRESHOLDS } from './thresholds.js';

export type Section = {
  title: string;
  body: string;
};

export type SplitResult = { shouldSplit: false } | { shouldSplit: true; sections: Section[] };

export type SplitInsertResult = {
  insertedIds: string[];
  newIds: string[];
  mergedIds: string[];
  mergedCount: number;
  relationsCreated: number;
};

type SplitMeta = {
  type: MemoryType;
  context?: string | null;
  source?: string | null;
  tags?: string[];
  importance?: number;
  detectContradictions?: boolean;
};

const MIN_CONTENT_LENGTH = 500;
const MIN_SECTION_BODY_LENGTH = 50;
const MIN_PREAMBLE_LENGTH = 100;
const MIN_SECTIONS_FOR_SPLIT = 2;

type SplitStrategy = {
  pattern: RegExp;
  extractTitle: (match: RegExpMatchArray) => string;
  validateMatch?: (content: string, match: RegExpExecArray) => boolean;
};

const STRATEGIES: SplitStrategy[] = [
  { pattern: /^## (.+)$/gm, extractTitle: (m) => m[1].trim() },
  { pattern: /^### (.+)$/gm, extractTitle: (m) => m[1].trim() },
  {
    pattern: /^\*\*([^*]+?)(?::)?\*\*(?::)?/gm,
    extractTitle: (m) => m[1].trim(),
    validateMatch: (_content, match) => {
      if (match[0].includes(':')) return true;
      const afterMatch = match.index + match[0].length;
      const lineEnd = _content.indexOf('\n', afterMatch);
      const endPos = lineEnd === -1 ? _content.length : lineEnd;
      const rest = _content.slice(afterMatch, endPos).trim();
      return rest.length === 0;
    },
  },
  { pattern: /^\d+\.\s+\*\*([^*]+)\*\*/gm, extractTitle: (m) => m[1].trim() },
];

function trySplitWithStrategy(content: string, strategy: SplitStrategy, originalTitle?: string): Section[] | null {
  const { pattern, extractTitle } = strategy;
  const headers: { title: string; index: number; match: RegExpExecArray }[] = [];

  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    headers.push({ title: extractTitle(match), index: match.index, match });
  }

  const validateFn = strategy.validateMatch;
  const validated = validateFn ? headers.filter((h) => validateFn(content, h.match)) : headers;

  if (validated.length < MIN_SECTIONS_FOR_SPLIT) return null;

  const sections: Section[] = [];

  if (validated[0].index > 0) {
    const preamble = content.slice(0, validated[0].index).trim();
    if (preamble.length >= MIN_PREAMBLE_LENGTH) {
      const preambleTitle = originalTitle ?? 'Overview';
      sections.push({ title: preambleTitle, body: preamble });
    }
  }

  for (let i = 0; i < validated.length; i++) {
    const start = validated[i].index;
    const end = i + 1 < validated.length ? validated[i + 1].index : content.length;
    const body = content.slice(start, end).trim();

    if (body.length < MIN_SECTION_BODY_LENGTH) continue;

    const sectionTitle = originalTitle ? `${originalTitle}: ${validated[i].title}` : validated[i].title;
    sections.push({ title: sectionTitle, body });
  }

  if (sections.length < MIN_SECTIONS_FOR_SPLIT) return null;
  return sections;
}

export function splitByTopics(content: string, title?: string): SplitResult {
  if (content.length < MIN_CONTENT_LENGTH) {
    return { shouldSplit: false };
  }

  for (const strategy of STRATEGIES) {
    const sections = trySplitWithStrategy(content, strategy, title);
    if (sections) {
      return { shouldSplit: true, sections };
    }
  }

  return { shouldSplit: false };
}

export async function insertSplitSections(
  db: MemoryDatabase,
  sections: Section[],
  meta: SplitMeta,
): Promise<SplitInsertResult> {
  const now = new Date().toISOString();
  const baseTags = normalizeTags([...(meta.tags ?? []), 'split-origin']);
  const defaultImportance = meta.type === 'pattern' ? 0.8 : 0.5;
  const importance = meta.importance ?? defaultImportance;

  const texts = sections.map((s) => `${s.title}\n\n${s.body}`);
  const embeddings = await generateEmbeddings(texts);

  const insertedIds: string[] = [];
  const newIds: string[] = [];
  const mergedIds: string[] = [];
  let mergedCount = 0;
  let relationsCreated = 0;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const emb = embeddings[i];

    if (emb) {
      const similar = db.findSimilarMemory(emb, THRESHOLDS.EXACT_DUPLICATE, meta.type);
      if (similar) {
        const existing = db.getMemoryByIdRaw(similar.id);
        if (existing) {
          const updates = buildMergeUpdates(existing, {
            content: section.body,
            title: section.title,
            tags: baseTags,
            context: meta.context ?? null,
            source: meta.source ?? null,
          });
          updates.importance = Math.min(1.0, existing.importance + 0.05);
          db.updateMemory(similar.id, updates);
          if (updates.content && updates.content !== existing.content) {
            db.updateMemoryEmbedding(similar.id, emb);
          }
          insertedIds.push(similar.id);
          mergedIds.push(similar.id);
          mergedCount++;
          continue;
        }
      }
    }

    const id = ulid();
    const row: MemoryRow = {
      id,
      type: meta.type,
      title: section.title,
      content: section.body,
      context: meta.context ?? null,
      source: meta.source ?? null,
      tags: JSON.stringify(baseTags),
      importance,
      created_at: now,
      updated_at: now,
      access_count: 0,
      last_accessed: null,
    };
    db.insertMemory(row);

    if (emb) {
      db.updateMemoryEmbedding(id, emb);

      if (meta.detectContradictions) {
        const related = db.findRelatedMemories(emb, 5);
        for (const c of related) {
          if (c.id === id) continue;
          const relMem = db.getMemoryByIdRaw(c.id);
          if (relMem && relMem.type === meta.type) {
            const weight = parseFloat((1 - c.distance).toFixed(3));
            try {
              db.addRelation(id, relMem.id, 'contradicts', weight);
            } catch (err) {
              process.stderr.write(`Warning: failed to create contradiction relation: ${err}\n`);
            }
          }
        }
      }
    }

    insertedIds.push(id);
    newIds.push(id);
  }

  const siblings = newIds;
  const useChainTopology = siblings.length > 5;

  if (useChainTopology) {
    for (let i = 0; i < siblings.length - 1; i++) {
      try {
        db.addRelation(siblings[i], siblings[i + 1], 'relates_to' as RelationType, 0.8);
        relationsCreated++;
      } catch (err) {
        process.stderr.write(`Warning: failed to create sibling relation: ${err}\n`);
      }
    }
  } else {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        try {
          db.addRelation(siblings[i], siblings[j], 'relates_to' as RelationType, 0.8);
          relationsCreated++;
        } catch (err) {
          process.stderr.write(`Warning: failed to create sibling relation: ${err}\n`);
        }
      }
    }
  }

  return { insertedIds, newIds, mergedIds, mergedCount, relationsCreated };
}
