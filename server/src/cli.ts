#!/usr/bin/env node

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { MemoryDatabase } from './database.js';
import { readStdin, writeHookOutput } from './cli/types.js';
import { handleSessionStart } from './cli/session-start.js';
import { handleSessionEnd } from './cli/session-end.js';
import { handleErrorContext } from './cli/error-context.js';

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

  // For session-start and error-context: missing DB means nothing to load
  if (subcommand !== 'session-end' && !existsSync(dbPath)) {
    process.exit(0);
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
