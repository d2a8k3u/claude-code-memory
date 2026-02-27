#!/usr/bin/env node

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { MemoryDatabase } from './database.js';
import { readStdin, writeHookOutput } from './cli/types.js';
import { handleSessionStart } from './cli/session-start.js';
import { handleSessionEnd } from './cli/session-end.js';
import { handleErrorContext } from './cli/error-context.js';
import { handleReorganize } from './cli/reorganize.js';

const subcommand = process.argv[2];

async function main() {
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
        const result = handleErrorContext(db, input);
        if (result) {
          writeHookOutput(result);
        }
        break;
      }
      case 'reorganize': {
        const result = await handleReorganize(db, input);
        writeHookOutput(result);
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
