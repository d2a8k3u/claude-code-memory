import type { MemoryDatabase } from '../database.js';
import type { MemoryType } from '../types.js';
import { splitByTopics, insertSplitSections } from '../topic-splitter.js';
import { safeParseTags } from '../merge-utils.js';
import type { HookInput, HookOutput } from './types.js';

const BATCH_SIZE = 50;

export async function handleReorganize(db: MemoryDatabase, _input: HookInput): Promise<HookOutput> {
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
