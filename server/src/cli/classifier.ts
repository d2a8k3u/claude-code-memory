import type { MemoryType } from '../types.js';

export type MemoryTypeHint = MemoryType | 'unknown';

export interface Classification {
  type: MemoryTypeHint;
  confidence: number;
}

const PATTERN_SIGNALS = [
  /\bdon['']?t\b/i,
  /\bnever\b/i,
  /\balways\b/i,
  /\bmust\b/i,
  /\buser (?:wants|prefers|requires|rejected|insists)\b/i,
  /\brule\b/i,
  /\bfeedback\b/i,
  /\bcorrection\b/i,
  /\bquality through\b/i,
  /\brather than\b/i,
  /\binstead of\b/i,
];

const PROCEDURAL_SIGNALS = [
  /\bto (?:build|run|deploy|install|test|lint)\b/i,
  /^\s*\d+\.\s/,
  /\bworkflow\b/i,
  /\bsteps?:\s/i,
  /\bnpm (?:run|test|install|build)\b/i,
  /\byarn\b/i,
  /\b(?:git|make|cargo|gradle|mvn)\s+\w+/i,
  /&& /,
];

const SEMANTIC_SIGNALS = [
  /\buses?\b.*\b(?:TypeScript|Python|Rust|Go|Java|Vue|React|Django|Express|FastAPI|SQLite|Postgres|MySQL|MongoDB|Redis)\b/,
  /\b(?:architecture|structure|stack|tech stack|framework)\b/i,
  /\bproject (?:is|uses|relies|runs)\b/i,
  /\b(?:module|package|library|component|subsystem) .* (?:lives?|hosts?|contains?|provides?)/i,
];

const EPISODIC_SIGNALS = [
  /\b(?:refactored|fixed|added|removed|implemented|updated|introduced|migrated|debugged|investigated)\b/i,
  /\b(?:session|turn|today|yesterday|just now)\b/i,
];

function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const p of patterns) if (p.test(text)) n++;
  return n;
}

export function classifyText(text: string): Classification {
  if (!text || text.trim().length < 3) {
    return { type: 'unknown', confidence: 0 };
  }

  const pat = countMatches(text, PATTERN_SIGNALS);
  const proc = countMatches(text, PROCEDURAL_SIGNALS);
  const sem = countMatches(text, SEMANTIC_SIGNALS);
  const ep = countMatches(text, EPISODIC_SIGNALS);

  const scores: Array<[MemoryTypeHint, number]> = [
    ['pattern', pat * 1.1],
    ['procedural', proc],
    ['semantic', sem],
    ['episodic', ep * 0.8],
  ];

  scores.sort((a, b) => b[1] - a[1]);
  const [bestType, bestScore] = scores[0];
  const secondScore = scores[1][1];

  if (bestScore === 0) {
    return { type: 'episodic', confidence: 0.3 };
  }

  const margin = bestScore - secondScore;
  const confidence = Math.min(1.0, 0.4 + 0.2 * bestScore + 0.1 * margin);
  return { type: bestType, confidence };
}
