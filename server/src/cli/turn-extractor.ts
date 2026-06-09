import type { MemoryDatabase } from '../database.js';
import type { MemoryRow } from '../types.js';
import { makeMemoryRecord } from './shared.js';
import { detectAndStorePatterns } from './pattern-detector.js';

export interface TurnToolCall {
  name: string;
  input: Record<string, unknown>;
  output: string | unknown;
}

export interface TurnContext {
  userMessage: string;
  assistantReply: string;
  toolCalls: TurnToolCall[];
  filesRead: string[];
  filesWritten: string[];
  errorCount: number;
  sessionId: string;
  turnIndex: number;
}

export type InsightCandidate = MemoryRow & { embedding?: Buffer | null };

// Imperative correction signals directed at the assistant. Bare "don't" and
// "actually" were removed: they fire on non-corrections like "I don't know how this
// works" or "actually that makes sense". "don't" now requires a following imperative
// verb so it reads as a directive ("don't use X"), not a statement of uncertainty.
const CORRECTION_SIGNALS = [
  /\bdon['']?t\s+(?:use|do|add|create|change|put|write|call|make|set|name|import|return|run|commit|hardcode|delete|remove)\b/i,
  /\bnever\b/i,
  /\bwrong way\b/i,
  /\bnope\b/i,
  /\bstop doing\b/i,
  /\binstead (?:of|use)\b/i,
  /\bnot (?:like (?:that|this)|the way)\b/i,
  /\brather (?:than|use)\b/i,
];

function hasCorrectionSignal(text: string): boolean {
  return CORRECTION_SIGNALS.some((r) => r.test(text));
}

function deriveTitle(text: string, maxLen = 80): string {
  const clean = text.replace(/[*_`#>]/g, '').trim();
  const firstSentence = clean.split(/(?<=[.!?])\s+/)[0] ?? clean;
  return firstSentence.length <= maxLen
    ? firstSentence
    : firstSentence.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
}

export function extractUserCorrection(ctx: TurnContext): InsightCandidate | null {
  if (!hasCorrectionSignal(ctx.userMessage)) return null;
  const hasConcreteAction = ctx.toolCalls.some((t) =>
    ['Edit', 'Write', 'Bash', 'NotebookEdit'].includes(t.name),
  );
  if (!hasConcreteAction) return null;

  const title = deriveTitle(ctx.userMessage);
  const lastAction = ctx.toolCalls[ctx.toolCalls.length - 1];
  const fp = lastAction?.input.file_path as string | undefined;
  const actionDesc = lastAction
    ? `Claude used ${lastAction.name}${fp ? ` on ${fp}` : ''}.`
    : 'Claude performed an action.';
  const content = `User correction: ${ctx.userMessage.trim()}\n\n${actionDesc}`;

  return makeMemoryRecord(
    'pattern',
    content,
    ['correction', 'user-request', `session:${ctx.sessionId}`, `turn:${ctx.turnIndex}`],
    { title, importance: 0.7, context: 'turn-extractor/correction' },
  );
}

const MODULE_PATH_RE = /\b((?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.[a-zA-Z]+)\b/g;
const TECH_RE =
  /\b(TypeScript|Python|Rust|Go|Node\.js|Vue\.js|Vue|React|Next\.js|Django|FastAPI|Express|SQLite|PostgreSQL|MySQL|Redis|MongoDB|Tailwind|Vite)\b/g;

export async function extractNewFact(
  ctx: TurnContext,
  db: MemoryDatabase,
): Promise<InsightCandidate | null> {
  const hasProbe = ctx.toolCalls.some((t) => ['Grep', 'Glob', 'Read'].includes(t.name));
  if (!hasProbe) return null;

  const reply = ctx.assistantReply;
  const paths = new Set<string>();
  for (const m of reply.matchAll(MODULE_PATH_RE)) paths.add(m[1]);
  const techs = new Set<string>();
  for (const m of reply.matchAll(TECH_RE)) techs.add(m[1]);

  if (paths.size === 0 && techs.size === 0) return null;

  const existingSem = db.listMemories('semantic', 50, 0);
  const knownContents = existingSem.map((m) => m.content);
  const novelPaths = [...paths].filter((p) => !knownContents.some((c) => c.includes(p)));
  const novelTechs = [...techs].filter((t) => !knownContents.some((c) => c.includes(t)));

  if (novelPaths.length === 0 && novelTechs.length === 0) return null;

  const parts: string[] = [];
  if (novelPaths.length > 0) parts.push(`Modules: ${novelPaths.join(', ')}`);
  if (novelTechs.length > 0) parts.push(`Technologies referenced: ${novelTechs.join(', ')}`);
  const content = parts.join('. ') + '.';
  const title = deriveTitle(content);

  return makeMemoryRecord(
    'semantic',
    content,
    ['auto-semantic', 'new-fact', `session:${ctx.sessionId}`],
    { title, importance: 0.4, context: 'turn-extractor/new-fact' },
  );
}

export async function extractPatternPromotion(
  _ctx: TurnContext,
  db: MemoryDatabase,
): Promise<number> {
  return detectAndStorePatterns(db);
}

export async function extractAll(ctx: TurnContext, db: MemoryDatabase): Promise<InsightCandidate[]> {
  const out: InsightCandidate[] = [];
  const correction = extractUserCorrection(ctx);
  if (correction) out.push(correction);
  const fact = await extractNewFact(ctx, db);
  if (fact) out.push(fact);
  return out;
}
