#!/usr/bin/env node

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { MemoryDatabase } from './database.js';
import { readStdin, writeHookOutput } from './cli/types.js';
import { handleSessionStart } from './cli/session-start.js';
import { handleSessionEnd } from './cli/session-end.js';
import { handleErrorContext } from './cli/error-context.js';
import { handleReorganize } from './cli/reorganize.js';
import { readBadge } from './cli/session-cache.js';

const subcommand = process.argv[2];

// `status` is user-invoked from a slash command with no stdin. readStdin() blocks
// on EOF, so branch out before it to avoid hanging a `node cli.js status` call.
async function handleStatus(): Promise<void> {
  const cwd = process.cwd();
  const dbPath = join(cwd, '.claude', 'memory-db', 'memory.sqlite');
  if (!existsSync(dbPath)) {
    console.log('No memory database found for this project. Run a session first to create it.');
    return;
  }
  const { buildHealthReport } = await import('./cli/health-report.js');
  const { isEmbeddingsAvailable } = await import('./embeddings.js');
  const { isRerankerAvailable } = await import('./reranker.js');
  const db = new MemoryDatabase(dbPath);
  try {
    const [embAvailable, rerankerAvailable] = await Promise.all([isEmbeddingsAvailable(), isRerankerAvailable()]);
    const report = await buildHealthReport(db.getHealthStats(), db.path, { embAvailable, rerankerAvailable });
    console.log(report);
  } finally {
    db.close();
  }
}

// `recall-mode` is user-invoked from a slash command with no stdin, so it must branch
// out before readStdin() (which blocks on EOF) — same guard as `status` (P3).
async function handleRecallMode(arg: string | undefined): Promise<void> {
  const cwd = process.cwd();
  const dbPath = join(cwd, '.claude', 'memory-db', 'memory.sqlite');
  if (!existsSync(dbPath)) {
    console.log('No memory database found for this project. Run a session first to create it.');
    return;
  }
  const { getRecallMode, setRecallMode } = await import('./cli/recall-mode.js');
  const db = new MemoryDatabase(dbPath);
  try {
    if (arg === 'off' || arg === 'normal') {
      setRecallMode(db, arg);
      console.log(`Recall mode set to '${arg}' for this project.`);
    } else if (arg === 'status' || arg === undefined) {
      console.log(`Recall mode is '${getRecallMode(db)}' for this project.`);
    } else {
      console.error(`Unknown recall-mode argument: ${arg}. Use: off | normal | status`);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

async function main() {
  // `statusline` runs on every prompt render and must stay off the DB hot path: it
  // reads a precomputed flat file written by session-start/prompt-submit. Branch out
  // before readStdin() (the statusLine schema is workspace.current_dir, not cwd, and
  // blocking on EOF would hang) and before the unconditional DB open below.
  if (subcommand === 'statusline') {
    console.log(readBadge(process.cwd()));
    return;
  }

  if (subcommand === 'status') {
    await handleStatus();
    return;
  }

  if (subcommand === 'recall-mode') {
    await handleRecallMode(process.argv[3]);
    return;
  }

  let input;
  try {
    input = await readStdin();
  } catch {
    process.exit(0);
  }

  const cwd = input.cwd ?? process.cwd();
  const dbPath = join(cwd, '.claude', 'memory-db', 'memory.sqlite');

  if (subcommand !== 'session-end' && subcommand !== 'reorganize' && !existsSync(dbPath)) {
    process.exit(0);
  }

  if (subcommand === 'reorganize' && !existsSync(dbPath)) {
    console.error('No memory database found. Run a session first to create the database.');
    process.exit(1);
  }

  const db = new MemoryDatabase(dbPath);
  try {
    switch (subcommand) {
      case 'session-start': {
        const result = await handleSessionStart(db, input);
        writeHookOutput(result);
        break;
      }
      case 'session-end': {
        const result = await handleSessionEnd(db, input);
        writeHookOutput(result);
        break;
      }
      case 'error-context': {
        const result = await handleErrorContext(db, input);
        if (result) {
          writeHookOutput(result);
        }
        break;
      }
      case 'prompt-submit': {
        const { handlePromptSubmit } = await import('./cli/prompt-submit.js');
        const result = await handlePromptSubmit(db, input);
        writeHookOutput(result);
        break;
      }
      case 'pre-tool-use': {
        const { handlePreToolUse } = await import('./cli/pre-tool-use.js');
        const result = await handlePreToolUse(db, input);
        writeHookOutput(result);
        break;
      }
      case 'reorganize': {
        const result = await handleReorganize(db, input);
        writeHookOutput(result);
        break;
      }
      case 'cleanup': {
        const { handleCleanup } = await import('./cli/cleanup.js');
        await handleCleanup(db, process.argv.slice(3));
        break;
      }
      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`cli ${subcommand} error:`, err);
  process.exit(1);
});
