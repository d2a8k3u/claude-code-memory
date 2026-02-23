import { ulid } from 'ulid';
import type { MemoryRow, MemoryType } from '../types.js';

export function makeMemoryRecord(
  type: MemoryType,
  content: string,
  tags: string[],
  opts?: { title?: string; importance?: number; context?: string },
): MemoryRow & { embedding?: Buffer | null } {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    type,
    title: opts?.title ?? null,
    content,
    context: opts?.context ?? 'auto-save',
    source: null,
    tags: JSON.stringify(tags),
    importance: opts?.importance ?? (type === 'pattern' ? 0.8 : 0.5),
    created_at: now,
    updated_at: now,
    access_count: 0,
    last_accessed: null,
    embedding: null,
  };
}

export const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'have',
  'been',
  'was',
  'were',
  'are',
  'has',
  'had',
  'not',
  'but',
  'its',
  'all',
  'can',
  'will',
  'may',
  'use',
  'used',
  'using',
  'into',
  'also',
  'than',
  'then',
  'when',
  'which',
  'where',
  'what',
  'how',
  'who',
  'each',
  'some',
  'any',
  'more',
  'most',
  'other',
  'over',
  'such',
  'only',
  'same',
  'just',
  'after',
  'before',
  'about',
  'between',
  'through',
  'during',
  'without',
  'again',
  'task',
  'tools',
  'files',
  'modified',
  'session',
  'auto',
  'save',
  'end',
  'error',
  'errors',
  'encountered',
  'memory',
  'ops',
  'searches',
  'stores',
]);

export function derivePatternTitle(texts: string[]): string {
  const wordCounts = new Map<string, number>();

  for (const text of texts) {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    const seen = new Set<string>();
    for (const word of words) {
      if (!seen.has(word)) {
        seen.add(word);
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }
  }

  const minCount = Math.max(2, Math.floor(texts.length * 0.5));
  const topWords = [...wordCounts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word]) => word);

  if (topWords.length === 0) return 'Recurring activity pattern';

  return topWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') + ' pattern';
}
