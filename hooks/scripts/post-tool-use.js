#!/usr/bin/env node

/**
 * PostToolUse hook for Bash errors.
 *
 * When a Bash command fails, searches the memory database for relevant
 * context and injects it as additionalContext.
 *
 * Fast path: if no error detected, exits immediately with no overhead.
 */

import { join } from "node:path";
import {
  openHookDb,
  searchMemoriesFts,
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

// Only process Bash tool results
if (hookInput.tool_name !== "Bash") {
  process.exit(0);
}

const output = hookInput.tool_output || "";

// Fast path: detect if output contains an error
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

const hasError = ERROR_PATTERNS.some(p => p.test(output));
if (!hasError) {
  process.exit(0);
}

// Extract search terms from the error
const first500 = output.slice(0, 500);
const searchTerms = new Set();

// Extract error class names (e.g., TypeError, ModuleNotFoundError)
const errorClasses = first500.match(/\b[A-Z][a-z]+(?:Error|Exception|Warning)\b/g);
if (errorClasses) errorClasses.forEach(e => searchTerms.add(e));

// Extract module/package names
const moduleMatch = first500.match(/(?:Cannot find module|ModuleNotFoundError|No module named|could not resolve)\s+['"]?([^'">\s]+)/i);
if (moduleMatch) searchTerms.add(moduleMatch[1]);

// Extract file paths mentioned in the error
const pathMatch = first500.match(/(?:\/[\w.-]+){2,}/g);
if (pathMatch) {
  for (const p of pathMatch.slice(0, 3)) {
    const basename = p.split("/").pop().replace(/\.[^.]+$/, "");
    if (basename && basename.length > 2) searchTerms.add(basename);
  }
}

// Extract key terms from the first error line
const firstErrorLine = first500.split("\n").find(line =>
  ERROR_PATTERNS.some(p => p.test(line))
);
if (firstErrorLine) {
  const words = firstErrorLine
    .split(/\s+/)
    .filter(w => w.length > 3 && /^[a-zA-Z]/.test(w))
    .slice(0, 5);
  words.forEach(w => searchTerms.add(w));
}

if (searchTerms.size === 0) {
  process.exit(0);
}

const cwd = hookInput.cwd || process.cwd();
const dbPath = join(cwd, ".claude", "memory-db", "memory.sqlite");

const db = openHookDb(dbPath);
if (!db) process.exit(0);

try {
  const query = [...searchTerms].slice(0, 5).join(" ");
  const results = searchMemoriesFts(db, query, { limit: 5 });

  db.close();

  if (results.length === 0) {
    process.exit(0);
  }

  const memories = results.map(m => {
    const titlePart = m.title ? `**${m.title}:** ` : "";
    return `- [${m.type}] ${titlePart}${m.content.slice(0, 200)}`;
  }).join("\n");

  const context = `## Relevant Memories for Error Context\n\nThe following memories may help with this error:\n\n${memories}`;

  const hookOutput = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(hookOutput));
  process.exit(0);
} catch {
  try { db.close(); } catch {}
  process.exit(0);
}
