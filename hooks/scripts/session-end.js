#!/usr/bin/env node

/**
 * Stop hook: saves a structured episodic session summary to the memory database.
 *
 * Reads the transcript to extract:
 * - First user message (task description)
 * - Tools used (excluding read-only tools)
 * - Files modified (from Edit/Write/Bash)
 * - Errors encountered
 * - Memory tool usage (search/store counts)
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  openHookDb,
  insertEpisodicMemory,
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
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}

const cwd = hookInput.cwd || process.cwd();
const dbPath = join(cwd, ".claude", "memory-db", "memory.sqlite");

const db = openHookDb(dbPath);
if (!db) {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}

try {
  const toolsUsed = new Set();
  const filesModified = new Set();
  let taskSummary = "";
  let errorCount = 0;
  let memorySearches = 0;
  let memoryStores = 0;

  const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

  const transcriptPath = hookInput.transcript_path;
  if (transcriptPath && existsSync(transcriptPath)) {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      // First user message → task description
      if (!taskSummary && msg.role === "user") {
        if (typeof msg.content === "string") {
          taskSummary = msg.content.slice(0, 300);
        } else if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find(b => b.type === "text" && b.text);
          if (textBlock) {
            taskSummary = textBlock.text.slice(0, 300);
          }
        }
      }

      // Parse assistant tool_use blocks
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            const name = block.name;
            if (name && !READ_ONLY_TOOLS.has(name)) {
              toolsUsed.add(name);
            }

            // Track memory tool usage
            if (name === "memory_search" || name === "mcp__claude-memory__memory_search") {
              memorySearches++;
            }
            if (name === "memory_store" || name === "mcp__claude-memory__memory_store") {
              memoryStores++;
            }

            // Track file modifications
            const inp = block.input || {};
            if (name === "Edit" || name === "Write") {
              if (inp.file_path) filesModified.add(inp.file_path);
            }
            if (name === "Bash" && inp.command) {
              // Basic heuristic: extract file paths from common write commands
              const cmd = inp.command;
              if (/\b(mv|cp|rm|mkdir|touch)\b/.test(cmd)) {
                const pathMatch = cmd.match(/[\w./-]+\.\w+/g);
                if (pathMatch) pathMatch.forEach(p => filesModified.add(p));
              }
            }
          }
        }
      }

      // Count errors in tool results
      if (msg.role === "tool" && typeof msg.content === "string") {
        if (/\b(error|Error|ERROR|failed|FAILED|Traceback|ENOENT|exit code [1-9])\b/.test(msg.content)) {
          errorCount++;
        }
      }
    }
  }

  // Build structured content
  const parts = [];
  if (taskSummary) {
    parts.push(`**Task:** ${taskSummary}`);
  }

  const meaningfulTools = [...toolsUsed];
  if (meaningfulTools.length > 0) {
    parts.push(`**Tools:** ${meaningfulTools.join(", ")}`);
  }

  if (filesModified.size > 0) {
    const files = [...filesModified].slice(0, 10).map(f =>
      f.replace(cwd + "/", "")
    );
    parts.push(`**Files:** ${files.join(", ")}`);
  }

  if (errorCount > 0) {
    parts.push(`**Errors:** ${errorCount}`);
  }

  if (memorySearches > 0 || memoryStores > 0) {
    parts.push(`**Memory ops:** ${memorySearches} searches, ${memoryStores} stores`);
  }

  // Only save if there's something meaningful
  if (parts.length === 0) {
    db.close();
    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  }

  const content = parts.join("\n");

  insertEpisodicMemory(db, {
    content,
    context: "session-end auto-save",
    tags: ["auto-save", "session-end"],
    importance: 0.5,
  });

  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
  db.close();
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
} catch {
  try { db.close(); } catch {}
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
