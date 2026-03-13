import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export interface GitSignals {
  cwd: string[];
  branch: string[];
  commits: string[];
  commitMessages: string[];
  files: string[];
}

export function extractGitSignals(cwd: string): GitSignals {
  const signals: GitSignals = { cwd: [], branch: [], commits: [], commitMessages: [], files: [] };

  const absPath = resolve(cwd);
  const segments = absPath.split('/').filter(Boolean);
  signals.cwd = [
    ...new Set(
      segments
        .slice(-2)
        .map((s) => s.toLowerCase())
        .filter((s) => s.length >= 3),
    ),
  ];

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 2000 }).toString().trim();
    if (branch) {
      const branchTerms = branch
        .replace(/^(feature|fix|bugfix|hotfix|chore|refactor)\//i, '')
        .split(/[-_/]/)
        .filter((t) => t.length > 2);
      signals.branch = [...new Set(branchTerms.map((t) => t.toLowerCase()))];
    }
  } catch {
    /* no git or timeout */
  }

  const COMMIT_PREFIX_RE = /^(feat|fix|chore|docs|refactor|test|style|build|ci|perf|revert)(\([^)]*\))?[!]?:\s*/i;
  const STOPWORDS =
    /^(the|and|for|with|from|that|this|have|been|add|update|remove|change|move|make|use|into|also|just|some|only|when|more|each|new|all|now|via|using|across|based)$/i;

  try {
    const commits = execSync('git log --oneline -3 --no-decorate', { cwd, timeout: 2000 }).toString().trim();
    if (commits) {
      const lines = commits.split('\n').map((line) => line.replace(/^[a-f0-9]+ /, ''));

      signals.commitMessages = lines
        .map((line) => line.replace(COMMIT_PREFIX_RE, '').trim())
        .filter((msg) => msg.length > 0);

      const words = lines
        .join(' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.test(w));
      signals.commits = [...new Set(words.slice(0, 10).map((w) => w.toLowerCase()))];
    }
  } catch {
    /* ignore */
  }

  try {
    const modified = execSync('git diff --name-only HEAD 2>/dev/null || git diff --name-only --cached', {
      cwd,
      timeout: 2000,
    })
      .toString()
      .trim();
    if (modified) {
      const fileTerms: string[] = [];
      const fileEntries = modified.split('\n').filter(Boolean);
      for (const f of fileEntries.slice(0, 10)) {
        const parts = f.split('/');
        fileTerms.push(...parts.filter((p) => p.length > 2 && !p.includes('.')));
        const basename = parts[parts.length - 1].replace(/\.[^.]+$/, '');
        if (basename.length > 2) fileTerms.push(basename);
      }
      signals.files = [...new Set(fileTerms.map((t) => t.toLowerCase()))];
    }
  } catch {
    /* ignore */
  }

  return signals;
}
