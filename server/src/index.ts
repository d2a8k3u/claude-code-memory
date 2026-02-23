#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { MemoryDatabase } from './database.js';
import { memoryToolDefs, handleMemoryTool } from './memory.js';

function resolveDbPath(): string {
  const projectRoot = process.cwd();
  return join(projectRoot, '.claude', 'memory-db', 'memory.sqlite');
}

async function main() {
  const dbPath = resolveDbPath();
  const db = new MemoryDatabase(dbPath);

  const server = new McpServer({
    name: 'claude-memory',
    version: '0.2.0',
  });

  for (const tool of memoryToolDefs) {
    server.tool(tool.name, tool.description, tool.schema, async (args: Record<string, unknown>) => {
      return handleMemoryTool(db, tool.name, args);
    });
  }

  process.on('SIGINT', () => {
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start claude-memory server:', err);
  process.exit(1);
});
