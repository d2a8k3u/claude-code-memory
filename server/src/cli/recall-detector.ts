// Strong, unambiguous recall triggers — they fire on their own.
const RECALL_TRIGGERS = [
  /\bdid we\b/i,
  /\bhave we\b/i,
  /\bwe (?:already|previously|earlier) (?:discussed|did|decided|tried|fixed|ran|built|implemented|changed)\b/i,
  /\bremember (?:the|when|that|how|our)\b/i,
  /\blast (?:time|session)\b/i,
  /\bwhat did we\b/i,
  /\bhow did we\b/i,
];

// Weak temporal words: only recall in the right company. Bare "before"/"earlier"/
// "previously"/"yesterday" fire on plenty of non-recall prompts ("read the file
// before you edit", "move this earlier in the function").
const WEAK_TEMPORAL = /\b(?:yesterday|previously|earlier|before)\b/i;

export function isRecallStyle(prompt: string): boolean {
  if (!prompt || prompt.trim().length < 8) return false;

  for (const p of RECALL_TRIGGERS) if (p.test(prompt)) return true;

  const temporal = WEAK_TEMPORAL.test(prompt);
  const firstPersonPlural = /\b(?:we|our|us)\b/i.test(prompt);
  const isQuestion = /\?/.test(prompt);
  const pastVerb = /\b(?:was|were|did|had|have)\b/i.test(prompt);

  // Shared first-person-plural work plus a temporal reference: clearly recall.
  if (temporal && firstPersonPlural) return true;

  // Past-tense question about shared work: "we" any time, or "you" only when a
  // temporal word is present ("what did you change earlier?" yes; "did you read X?" no).
  if (isQuestion && pastVerb && (firstPersonPlural || (/\byou\b/i.test(prompt) && temporal))) {
    return true;
  }

  return false;
}
