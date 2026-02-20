import type { MemoryDatabase } from '../database.js';
import type { HookInput, HookOutput } from './types.js';

const ERROR_PATTERNS = [
  /\bError:\s/,
  /\bERROR\b/,
  /\bfailed\b/i,
  /\bFAILED\b/,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bTraceback\b/,
  /\bcommand not found\b/,
  /\bNo such file or directory\b/,
  /\bPermission denied\b/,
  /\bexit code [1-9]/,
  /\bnpm ERR!\b/,
  /\bTypeError\b/,
  /\bSyntaxError\b/,
  /\bReferenceError\b/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /\bCompilation failed\b/i,
  /\bcannot find module\b/i,
];

export function handleErrorContext(db: MemoryDatabase, input: HookInput): HookOutput | null {
  if (input.tool_name !== 'Bash') return null;

  const output = input.tool_output ?? '';
  const hasError = ERROR_PATTERNS.some((p) => p.test(output));
  if (!hasError) return null;

  const first500 = output.slice(0, 500);
  const searchTerms = new Set<string>();

  // Extract error class names
  const errorClasses = first500.match(/\b[A-Z][a-z]+(?:Error|Exception|Warning)\b/g);
  if (errorClasses) errorClasses.forEach((e) => searchTerms.add(e));

  // Extract module/package names
  const moduleMatch = first500.match(
    /(?:Cannot find module|ModuleNotFoundError|No module named|could not resolve)\s+['"]?([^'">\s]+)/i,
  );
  if (moduleMatch) searchTerms.add(moduleMatch[1]);

  // Extract file paths mentioned in the error
  const pathMatch = first500.match(/(?:\/[\w.-]+){2,}/g);
  if (pathMatch) {
    for (const p of pathMatch.slice(0, 3)) {
      const basename = p.split('/').pop()?.replace(/\.[^.]+$/, '');
      if (basename && basename.length > 2) searchTerms.add(basename);
    }
  }

  // Extract key terms from the first error line
  const firstErrorLine = first500.split('\n').find((line) => ERROR_PATTERNS.some((p) => p.test(line)));
  if (firstErrorLine) {
    const words = firstErrorLine
      .split(/\s+/)
      .filter((w) => w.length > 3 && /^[a-zA-Z]/.test(w))
      .slice(0, 5);
    words.forEach((w) => searchTerms.add(w));
  }

  if (searchTerms.size === 0) return null;

  const query = [...searchTerms].slice(0, 5).join(' ');
  const results = db.searchMemories(query, 5);

  if (results.length === 0) return null;

  const memories = results
    .map((m) => {
      const titlePart = m.title ? `**${m.title}:** ` : '';
      return `- [${m.type}] ${titlePart}${m.content.slice(0, 200)}`;
    })
    .join('\n');

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `## Relevant Memories for Error Context\n\nThe following memories may help with this error:\n\n${memories}`,
    },
  };
}
