import type { MemoryRow } from '../types.js';

const HIGH_IMPORTANCE = 0.75;

function stripMarkdown(s: string): string {
  return s.replace(/\*{1,3}|_{1,3}|`{1,3}|~{2}|#{1,6}\s?/g, '').trim();
}

function truncate(s: string, max = 120): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

// Patterns are rules to act on; give them room so a directive is never cut mid-rule.
const PATTERN_MAX = 300;

function typeLabel(m: MemoryRow): string {
  const star = m.type === 'pattern' && m.importance >= HIGH_IMPORTANCE ? ' ★' : '';
  if (m.type === 'episodic') {
    const date = m.created_at.slice(0, 10);
    return `[episodic ${date}]`;
  }
  return `[${m.type}${star}]`;
}

export function formatMemoryLine(m: MemoryRow, relationType?: string): string {
  const label = typeLabel(m);
  const title = m.title ? stripMarkdown(m.title) : '';
  const content = stripMarkdown(m.content);
  const prefix = title ? `${title} — ` : '';
  if (relationType) {
    return `  - [${m.type} → ${relationType}] ${prefix}${truncate(content, 140)}`;
  }
  // Patterns/corrections are rules to apply, not trivia to note — surface them as an
  // explicit directive and don't truncate mid-rule (generous cap keeps the rule intact).
  if (m.type === 'pattern') {
    const body = title ? `${title}: ${truncate(content, PATTERN_MAX)}` : truncate(content, PATTERN_MAX);
    return `- ${label} Apply — ${body}`;
  }
  return `- ${label} ${prefix}${truncate(content, 180)}`;
}

export interface BlockOptions {
  sessionNum: number;
  heading?: string;
}

export function formatBlock(memories: MemoryRow[], opts: BlockOptions): string {
  if (memories.length === 0) return '';
  const heading = opts.heading ?? `## Memory (session #${opts.sessionNum}, auto-recalled)`;
  const lines = memories.map((m) => formatMemoryLine(m));
  return `${heading}\n\n${lines.join('\n')}\n`;
}

export function formatWarningBlock(m: MemoryRow, filePath: string): string {
  const title = m.title ? stripMarkdown(m.title) : stripMarkdown(m.content).slice(0, 60);
  const content = stripMarkdown(m.content);
  return `## Memory check before Edit

⚠️ **Prior rule applies to \`${filePath}\`:**
${title ? `**${title}** — ` : ''}${content}

Apply this rule, or state why it does not apply, before continuing.
`;
}

export function formatBlockWithRelations(
  primaries: MemoryRow[],
  neighbours: Array<{ memory: MemoryRow; relationType: string }>,
  opts: BlockOptions,
): string {
  if (primaries.length === 0 && neighbours.length === 0) return '';
  const heading = opts.heading ?? `## Memory (session #${opts.sessionNum}, auto-recalled)`;

  // Attach every neighbour under the first primary; simple but readable.
  const lines: string[] = [];
  if (primaries.length === 0) {
    for (const nb of neighbours) lines.push(formatMemoryLine(nb.memory, nb.relationType));
  } else {
    for (let i = 0; i < primaries.length; i++) {
      lines.push(formatMemoryLine(primaries[i]));
      if (i === 0) {
        for (const nb of neighbours) {
          lines.push(formatMemoryLine(nb.memory, nb.relationType));
        }
      }
    }
  }

  return `${heading}\n\n${lines.join('\n')}\n`;
}
