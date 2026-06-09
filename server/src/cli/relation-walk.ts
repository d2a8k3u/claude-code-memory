import type { MemoryDatabase } from '../database.js';
import type { MemoryRow, MemoryType } from '../types.js';

export interface ExpandOptions {
  /** Maximum number of neighbours to add across all selected memories. */
  maxNeighbors: number;
  /** Minimum relation weight to consider a neighbour "strong". */
  minWeight: number;
  /** IDs to skip (already in primary set or session cache). */
  dedupSet: Set<string>;
  /** Per-type caps remaining — expansion must not exceed these. */
  typeCaps: Partial<Record<MemoryType, number>>;
}

export interface ExpandedNeighbour {
  memory: MemoryRow;
  relationType: string;
  weight: number;
}

export function expandByRelations(
  db: MemoryDatabase,
  selectedIds: string[],
  opts: ExpandOptions,
): ExpandedNeighbour[] {
  const collected: ExpandedNeighbour[] = [];
  const typeUsed: Partial<Record<MemoryType, number>> = {};

  for (const id of selectedIds) {
    if (collected.length >= opts.maxNeighbors) break;

    const relations = db.getRelations(id);
    relations.sort((a, b) => b.weight - a.weight);

    for (const rel of relations) {
      if (collected.length >= opts.maxNeighbors) break;
      if (rel.weight < opts.minWeight) continue;

      const otherId = rel.source_id === id ? rel.target_id : rel.source_id;
      if (opts.dedupSet.has(otherId)) continue;

      const other = db.getMemoryByIdRaw(otherId);
      if (!other) continue;
      // Superseded (stale) memories are not surfaced as neighbours.
      if (other.superseded_by != null) continue;

      const t = other.type as MemoryType;
      const cap = opts.typeCaps[t];
      if (cap !== undefined && (typeUsed[t] ?? 0) >= cap) continue;

      collected.push({ memory: other, relationType: rel.relation_type, weight: rel.weight });
      typeUsed[t] = (typeUsed[t] ?? 0) + 1;
      opts.dedupSet.add(otherId);
    }
  }

  return collected;
}
