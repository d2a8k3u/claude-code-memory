import { ulid } from 'ulid';
import type { MemoryDatabase } from '../database.js';
import type { MemoryRow } from '../types.js';
import { generateEmbedding, embeddingToBuffer } from '../embeddings.js';
import type { HookInput, HookOutput } from './types.js';
import { parseTranscript } from './transcript.js';

function makeEpisodicRecord(
  content: string,
  tags: string[],
): MemoryRow & { embedding?: Buffer | null } {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    type: 'episodic',
    title: null,
    content,
    context: 'session-end auto-save',
    source: null,
    tags: JSON.stringify(tags),
    importance: 0.5,
    created_at: now,
    updated_at: now,
    access_count: 0,
    last_accessed: null,
    embedding: null,
  };
}

export async function handleSessionEnd(db: MemoryDatabase, input: HookInput): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const summary = parseTranscript(input.transcript_path ?? '', cwd);

  const mainParts: string[] = [];
  if (summary.taskSummary) mainParts.push(`**Task:** ${summary.taskSummary}`);
  if (summary.toolsUsed.length > 0) mainParts.push(`**Tools:** ${summary.toolsUsed.join(', ')}`);
  if (summary.memorySearches > 0 || summary.memoryStores > 0) {
    mainParts.push(`**Memory ops:** ${summary.memorySearches} searches, ${summary.memoryStores} stores`);
  }

  if (mainParts.length === 0 && summary.filesModified.length === 0 && summary.errorCount === 0) {
    return { ok: true };
  }

  // Main session record (task + tools + memory ops)
  if (mainParts.length > 0) {
    const mainContent = mainParts.join('\n');
    const mainRecord = makeEpisodicRecord(mainContent, ['auto-save', 'session-end']);
    const embedding = await generateEmbedding(mainContent);
    if (embedding) {
      mainRecord.embedding = embeddingToBuffer(embedding);
    }
    db.insertMemory(mainRecord);
  }

  // Files-modified record
  if (summary.filesModified.length > 0) {
    const filesContent = `**Files modified:** ${summary.filesModified.join(', ')}`;
    const filesRecord = makeEpisodicRecord(filesContent, ['auto-save', 'session-files']);
    const embedding = await generateEmbedding(filesContent);
    if (embedding) {
      filesRecord.embedding = embeddingToBuffer(embedding);
    }
    db.insertMemory(filesRecord);
  }

  // Errors record
  if (summary.errorCount > 0) {
    const taskContext = summary.taskSummary ? ` during: ${summary.taskSummary.slice(0, 100)}` : '';
    const errorsContent = `**Errors encountered:** ${summary.errorCount} errors during session${taskContext}`;
    const errorsRecord = makeEpisodicRecord(errorsContent, ['auto-save', 'session-errors']);
    const embedding = await generateEmbedding(errorsContent);
    if (embedding) {
      errorsRecord.embedding = embeddingToBuffer(embedding);
    }
    db.insertMemory(errorsRecord);
  }

  return { ok: true };
}
