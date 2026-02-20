import { ulid } from 'ulid';
import type { MemoryDatabase } from '../database.js';
import type { MemoryRow } from '../types.js';
import { generateEmbedding, embeddingToBuffer } from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { parseTranscript } from './transcript.js';

export async function handleSessionEnd(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const summary = parseTranscript(input.transcript_path ?? '', cwd);

  const parts: string[] = [];
  if (summary.taskSummary) parts.push(`**Task:** ${summary.taskSummary}`);
  if (summary.toolsUsed.length > 0) parts.push(`**Tools:** ${summary.toolsUsed.join(', ')}`);
  if (summary.filesModified.length > 0) parts.push(`**Files:** ${summary.filesModified.join(', ')}`);
  if (summary.errorCount > 0) parts.push(`**Errors:** ${summary.errorCount}`);
  if (summary.memorySearches > 0 || summary.memoryStores > 0) {
    parts.push(`**Memory ops:** ${summary.memorySearches} searches, ${summary.memoryStores} stores`);
  }

  if (parts.length === 0) return { ok: true };

  const content = parts.join('\n');
  const now = new Date().toISOString();
  const id = ulid();

  const embedding = await generateEmbedding(content);
  const embeddingBuf = embedding ? embeddingToBuffer(embedding) : null;

  const memory: MemoryRow & { embedding?: Buffer | null } = {
    id,
    type: 'episodic',
    title: null,
    content,
    context: 'session-end auto-save',
    source: null,
    tags: JSON.stringify(['auto-save', 'session-end']),
    importance: 0.5,
    created_at: now,
    updated_at: now,
    access_count: 0,
    last_accessed: null,
    embedding: embeddingBuf,
  };

  db.insertMemory(memory);
  return { ok: true };
}
