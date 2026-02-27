import type { MemoryRow } from './types.js';

export function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter((t) => t.length > 0 && t.length <= 50),
    ),
  ];
}

export function safeParseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface MergeInput {
  content: string;
  title?: string | null;
  tags?: string[];
  context?: string | null;
  source?: string | null;
}

export function buildMergeUpdates(existing: MemoryRow, incoming: MergeInput): Record<string, unknown> {
  const updates: Record<string, unknown> = {};

  if (incoming.content.length > existing.content.length) {
    updates.content = incoming.content;
  }

  if (incoming.title && !existing.title) {
    updates.title = incoming.title;
  }

  const existingTags = normalizeTags(safeParseTags(existing.tags));
  const incomingTags = normalizeTags(incoming.tags ?? []);
  const unionTags = [...new Set([...existingTags, ...incomingTags])];

  if (unionTags.length > existingTags.length) {
    updates.tags = JSON.stringify(unionTags);
  }

  if (incoming.context && !existing.context) {
    updates.context = incoming.context;
  }

  if (incoming.source && !existing.source) {
    updates.source = incoming.source;
  }

  return updates;
}
