import type { MemoryDatabase } from '../database.js';
import type { MemoryRow, MemoryType } from '../types.js';
import { generateEmbedding } from '../embeddings.js';
import { splitByTopics, insertSplitSections } from '../topic-splitter.js';
import { safeParseTags } from '../merge-utils.js';
import { parseListContent } from './session-end.js';
import type { HookInput, HookOutput } from './types.js';

const BATCH_SIZE = 50;
const ACCUMULATIVE_TAGS = ['tech-stack', 'active-modules'];

export async function handleReorganize(db: MemoryDatabase, _input: HookInput): Promise<HookOutput> {
  const deduped = await deduplicateAccumulativeRecords(db);

  const types: MemoryType[] = ['semantic', 'procedural', 'pattern'];

  let totalProcessed = 0;
  let totalSplit = 0;
  let totalCreated = 0;
  let totalMerged = 0;
  let totalRelations = 0;
  let totalDeleted = 0;
  const consumedIds = new Set<string>();

  for (const type of types) {
    let offset = 0;
    while (true) {
      const memories = db.listMemories(type, BATCH_SIZE, offset);
      if (memories.length === 0) break;

      for (const mem of memories) {
        if (consumedIds.has(mem.id)) continue;

        const tags = safeParseTags(mem.tags);
        if (tags.includes('split-origin')) continue;

        totalProcessed++;

        try {
          const split = splitByTopics(mem.content, mem.title ?? undefined);
          if (!split.shouldSplit) continue;

          const result = await insertSplitSections(db, split.sections, {
            type,
            context: mem.context,
            source: mem.source,
            tags,
            importance: mem.importance,
          });

          if (result.newIds.length >= 2) {
            db.transaction(() => {
              const existingRelations = db.getRelations(mem.id);
              for (const rel of existingRelations) {
                for (const newId of result.newIds) {
                  const sourceId = rel.source_id === mem.id ? newId : rel.source_id;
                  const targetId = rel.target_id === mem.id ? newId : rel.target_id;
                  if (sourceId !== targetId) {
                    try {
                      db.addRelation(sourceId, targetId, rel.relation_type, rel.weight);
                    } catch {
                      // INSERT OR REPLACE handles duplicates; catch covers unexpected errors
                    }
                  }
                }
              }
              db.deleteMemory(mem.id);
            });

            totalSplit++;
            totalCreated += result.newIds.length;
            totalMerged += result.mergedCount;
            totalRelations += result.relationsCreated;
            totalDeleted++;

            for (const mergedId of result.mergedIds) {
              consumedIds.add(mergedId);
            }
          }
        } catch {
          // Original memory preserved on error
          continue;
        }
      }

      offset += BATCH_SIZE;
    }
  }

  const report = [
    '# Memory Reorganization Report',
    '',
    `- **Deduplicated:** ${deduped} accumulative records merged`,
    `- **Processed:** ${totalProcessed} memories`,
    `- **Split:** ${totalSplit} memories decomposed by topic`,
    `- **Created:** ${totalCreated} new topic-specific memories`,
    `- **Merged:** ${totalMerged} with existing similar memories`,
    `- **Relations:** ${totalRelations} sibling relations created`,
    `- **Deleted:** ${totalDeleted} original monolithic memories`,
    `- **Total memories:** ${db.countMemories()}`,
  ].join('\n');

  process.stderr.write(report + '\n');

  return { ok: true };
}

async function deduplicateAccumulativeRecords(db: MemoryDatabase): Promise<number> {
  let totalDeduped = 0;

  for (const tag of ACCUMULATIVE_TAGS) {
    const all = db.listMemories('semantic', 200, 0);
    const matches = all.filter((m) => safeParseTags(m.tags).includes(tag));
    if (matches.length <= 1) continue;

    const keep = pickBestRecord(matches);
    const rest = matches.filter((m) => m.id !== keep.id);

    const mergedItems = new Set<string>();
    for (const m of matches) {
      for (const item of parseListContent(m.content)) {
        mergedItems.add(item);
      }
    }

    const prefix = keep.content.slice(0, keep.content.indexOf(':') + 1);
    const mergedContent = `${prefix} ${[...mergedItems].sort().join(', ')}`;

    db.updateMemory(keep.id, { content: mergedContent });

    const newEmb = await generateEmbedding(mergedContent);
    if (newEmb) {
      db.updateMemoryEmbedding(keep.id, newEmb);
    }

    for (const dup of rest) {
      db.deleteMemory(dup.id);
    }

    totalDeduped += rest.length;
  }

  return totalDeduped;
}

function pickBestRecord(records: MemoryRow[]): MemoryRow {
  return records.reduce((best, curr) => {
    const bestLen = parseListContent(best.content).length;
    const currLen = parseListContent(curr.content).length;
    if (currLen !== bestLen) return currLen > bestLen ? curr : best;
    return curr.importance > best.importance ? curr : best;
  });
}
