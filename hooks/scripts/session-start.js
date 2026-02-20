#!/usr/bin/env node

/**
 * SessionStart hook: Git-aware context loading, cleanup, decay, consolidation trigger.
 *
 * Phase 1: Git signals (branch, commits, modified files)
 * Phase 2: Cleanup + lightweight consolidation (decay, stale cleanup)
 * Phase 3: Context-aware retrieval (FTS search + top memories)
 * Phase 4: Check consolidation trigger (every 10 sessions)
 * Phase 5: Format additionalContext with behavioral instructions
 */

import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  openHookDb,
  searchMemoriesFts,
  deleteWorkingMemories,
  cleanupOldEpisodic,
  decayImportance,
  getRecentEpisodic,
  getTopByImportance,
  getPatterns,
  ensureMetaTable,
  getSessionMeta,
  setSessionMeta,
} from "./lib/db.js";

// Read hook input from stdin
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

let hookInput;
try {
  hookInput = JSON.parse(input);
} catch {
  process.exit(0);
}

const cwd = hookInput.cwd || process.cwd();
const dbPath = join(cwd, ".claude", "memory-db", "memory.sqlite");

const db = openHookDb(dbPath);
if (!db) process.exit(0);

try {
  // ── Phase 1: Git signals ──────────────────────────────────────────────
  const gitSignals = [];

  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 2000 })
      .toString().trim();
    if (branch) {
      // Split branch name into search terms: feature/auth-module → auth module
      const branchTerms = branch
        .replace(/^(feature|fix|bugfix|hotfix|chore|refactor)\//i, "")
        .split(/[-_/]/)
        .filter(t => t.length > 2);
      gitSignals.push(...branchTerms);
    }
  } catch { /* no git or timeout */ }

  try {
    const commits = execSync("git log --oneline -5 --no-decorate", { cwd, timeout: 2000 })
      .toString().trim();
    if (commits) {
      // Extract meaningful words from commit messages
      const words = commits
        .split("\n")
        .map(line => line.replace(/^[a-f0-9]+ /, ""))
        .join(" ")
        .split(/\s+/)
        .filter(w => w.length > 3 && !/^(the|and|for|with|from|that|this|have|been)$/i.test(w));
      gitSignals.push(...words.slice(0, 10));
    }
  } catch { /* ignore */ }

  try {
    const modified = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only --cached", { cwd, timeout: 2000 })
      .toString().trim();
    if (modified) {
      const files = modified.split("\n").filter(Boolean);
      for (const f of files.slice(0, 10)) {
        // Extract directory and basename parts
        const parts = f.split("/");
        gitSignals.push(...parts.filter(p => p.length > 2 && !p.includes(".")));
        const basename = parts[parts.length - 1].replace(/\.[^.]+$/, "");
        if (basename.length > 2) gitSignals.push(basename);
      }
    }
  } catch { /* ignore */ }

  // Deduplicate git signals
  const uniqueSignals = [...new Set(gitSignals.map(s => s.toLowerCase()))];

  // ── Phase 2: Cleanup + lightweight consolidation ──────────────────────
  const workingCleaned = deleteWorkingMemories(db);
  const episodicCleaned = cleanupOldEpisodic(db, 90);
  const decayed = decayImportance(db, 30, 0.05);

  // Track session count
  ensureMetaTable(db);
  const sessionCount = parseInt(getSessionMeta(db, "session_count") || "0", 10) + 1;
  setSessionMeta(db, "session_count", String(sessionCount));

  // ── Phase 3: Context-aware retrieval ──────────────────────────────────
  const sections = [];
  const seenIds = new Set();

  // FTS search with git signals
  let relevantMemories = [];
  if (uniqueSignals.length > 0) {
    const searchQuery = uniqueSignals.slice(0, 5).join(" ");
    relevantMemories = searchMemoriesFts(db, searchQuery, { limit: 10 });
  }

  if (relevantMemories.length > 0) {
    sections.push("## Relevant to Current Work");
    for (const mem of relevantMemories) {
      seenIds.add(mem.id);
      const titlePart = mem.title ? `**${mem.title}:** ` : "";
      sections.push(`- [${mem.type}] ${titlePart}${mem.content.slice(0, 200)}`);
    }
  }

  // Recent episodic memories
  const recentEpisodic = getRecentEpisodic(db, 3);
  const newEpisodic = recentEpisodic.filter(m => !seenIds.has(m.id));
  if (newEpisodic.length > 0) {
    sections.push("\n## Recent Sessions");
    for (const mem of newEpisodic) {
      seenIds.add(mem.id);
      const date = mem.created_at.slice(0, 10);
      const ctx = mem.context ? ` (${mem.context})` : "";
      sections.push(`- [${date}]${ctx} ${mem.content.slice(0, 200)}`);
    }
  }

  // Top semantic memories
  const semanticMems = getTopByImportance(db, { type: "semantic", minImportance: 0.5, limit: 5 });
  const newSemantic = semanticMems.filter(m => !seenIds.has(m.id));
  if (newSemantic.length > 0) {
    sections.push("\n## Key Knowledge");
    for (const mem of newSemantic) {
      seenIds.add(mem.id);
      const titlePart = mem.title ? `**${mem.title}:** ` : "";
      sections.push(`- ${titlePart}${mem.content.slice(0, 200)}`);
    }
  }

  // Top patterns
  const patterns = getPatterns(db, 5);
  const newPatterns = patterns.filter(m => !seenIds.has(m.id));
  if (newPatterns.length > 0) {
    sections.push("\n## Patterns & Conventions");
    for (const mem of newPatterns) {
      seenIds.add(mem.id);
      const title = mem.title || "Untitled pattern";
      sections.push(`- **${title}:** ${mem.content.slice(0, 200)}`);
    }
  }

  // Top procedural memories
  const procedures = getTopByImportance(db, { type: "procedural", minImportance: 0.5, limit: 3 });
  const newProcedures = procedures.filter(m => !seenIds.has(m.id));
  if (newProcedures.length > 0) {
    sections.push("\n## Procedures");
    for (const mem of newProcedures) {
      seenIds.add(mem.id);
      const titlePart = mem.title ? `**${mem.title}:** ` : "";
      sections.push(`- ${titlePart}${mem.content.slice(0, 200)}`);
    }
  }

  // ── Phase 4: Check consolidation trigger ──────────────────────────────
  const lastConsolidation = parseInt(getSessionMeta(db, "last_consolidation") || "0", 10);
  const consolidationNeeded = (sessionCount - lastConsolidation) >= 10;

  if (consolidationNeeded) {
    setSessionMeta(db, "last_consolidation", String(sessionCount));
  }

  db.close();

  // ── Phase 5: Format output ────────────────────────────────────────────
  const cleanupParts = [];
  if (workingCleaned) cleanupParts.push(`${workingCleaned} working cleared`);
  if (episodicCleaned) cleanupParts.push(`${episodicCleaned} old episodic archived`);
  if (decayed) cleanupParts.push(`${decayed} decayed`);
  const cleanupNote = cleanupParts.length > 0 ? ` (${cleanupParts.join(", ")})` : "";

  const totalMems = seenIds.size;
  const header = `# Project Memory Context (${totalMems} items loaded, session #${sessionCount})${cleanupNote}\n`;

  // Behavioral instructions — always included
  const behavioralInstructions = `
## Memory System

You have project memory via MCP tools. Use it automatically without asking.

### Auto-Recall
- On errors: \`memory_search\` with error keywords
- Starting a module: \`memory_search\` with module/component name
- Before decisions: \`memory_search\` for prior decisions (filter type "pattern" or tag "decision")

### Auto-Save
After resolving non-trivial problems, silently store what you learned:
- Bug fix → \`memory_store\` type "episodic" (what broke + fix)
- Project fact → \`memory_store\` type "semantic" (with title)
- Procedure → \`memory_store\` type "procedural"
- Pattern noticed → \`memory_store\` type "pattern" (with title, importance 0.8)

### Rules
- Search before storing (avoid duplicates)
- Be concise (1-3 sentences per memory)
- Lowercase hyphenated tags
- Don't store trivial actions
- Don't ask user before saving`;

  // Consolidation prompt — only every 10 sessions
  let consolidationPrompt = "";
  if (consolidationNeeded) {
    consolidationPrompt = `

### Consolidation Due

Before starting the user's task, spend a moment on memory maintenance:

1. \`memory_list\` — check totals per type
2. \`memory_search\` broad terms to find duplicates → merge or delete redundant ones
3. Multiple episodic memories about the same topic → create one \`pattern\` memory, link with \`derived_from\`
4. Lower importance of stale memories not worth keeping
5. Check for contradictions → link with \`contradicts\` relation
6. Briefly report what you cleaned up, then proceed with the task`;
  }

  const context = header + sections.join("\n") + behavioralInstructions + consolidationPrompt;

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
} catch {
  try { db.close(); } catch {}
  process.exit(0);
}
