const RECALL_TRIGGERS = [
  /\bdid we\b/i,
  /\bhave we\b/i,
  /\bwe (?:already|previously|earlier) (?:discussed|did|decided|tried|fixed|ran)\b/i,
  /\bremember (?:the|when|that)\b/i,
  /\blast (?:time|session)\b/i,
  /\byesterday\b/i,
  /\bpreviously\b/i,
  /\bearlier\b/i,
  /\bbefore\b/i,
  /\bwhat did we\b/i,
  /\bhow did we\b/i,
];

export function isRecallStyle(prompt: string): boolean {
  if (!prompt || prompt.trim().length < 8) return false;

  for (const p of RECALL_TRIGGERS) if (p.test(prompt)) return true;

  if (/\?/.test(prompt) && /\b(?:was|were|did|had|have)\b/i.test(prompt)) {
    return true;
  }

  return false;
}
