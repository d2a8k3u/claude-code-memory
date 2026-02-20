import { execSync } from 'node:child_process';

export function extractGitSignals(cwd: string): string[] {
  const signals: string[] = [];

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 2000 }).toString().trim();
    if (branch) {
      const branchTerms = branch
        .replace(/^(feature|fix|bugfix|hotfix|chore|refactor)\//i, '')
        .split(/[-_/]/)
        .filter((t) => t.length > 2);
      signals.push(...branchTerms);
    }
  } catch {
    /* no git or timeout */
  }

  try {
    const commits = execSync('git log --oneline -5 --no-decorate', { cwd, timeout: 2000 }).toString().trim();
    if (commits) {
      const words = commits
        .split('\n')
        .map((line) => line.replace(/^[a-f0-9]+ /, ''))
        .join(' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !/^(the|and|for|with|from|that|this|have|been)$/i.test(w));
      signals.push(...words.slice(0, 10));
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
      const files = modified.split('\n').filter(Boolean);
      for (const f of files.slice(0, 10)) {
        const parts = f.split('/');
        signals.push(...parts.filter((p) => p.length > 2 && !p.includes('.')));
        const basename = parts[parts.length - 1].replace(/\.[^.]+$/, '');
        if (basename.length > 2) signals.push(basename);
      }
    }
  } catch {
    /* ignore */
  }

  return [...new Set(signals.map((s) => s.toLowerCase()))];
}
