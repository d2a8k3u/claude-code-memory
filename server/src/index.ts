#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryDatabase } from './database.js';
import { memoryToolDefs, handleMemoryTool } from './memory.js';
import { rowToMemory } from './types.js';

const GRAPH_PORT = 7337;

function resolveDbPath(): string {
  const projectRoot = process.cwd();
  return join(projectRoot, '.claude', 'memory-db', 'memory.sqlite');
}

function resolveGraphHtml(): string {
  // In dev (tsx): import.meta.url points to src/index.ts
  // In built (dist): import.meta.url points to dist/index.js
  // graph.html lives in src/ — try both locations
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(thisDir, 'graph.html'), join(thisDir, '..', 'src', 'graph.html')];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      // try next
    }
  }
  return '<html><body><h1>graph.html not found</h1></body></html>';
}

function startHttpServer(db: MemoryDatabase): void {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/memories') {
      try {
        const rows = db.listMemories(undefined, 10000, 0);
        const relations = db.getAllRelations();

        const nodes = rows.map((row) => {
          const m = rowToMemory(row);
          const rawLabel = m.title || m.content;
          const label = rawLabel
            .replace(/\*{1,2}|#{1,6}\s?|`{1,3}|~{2}/g, '')
            .trim()
            .split(/\s+/)
            .slice(0, 4)
            .join(' ');
          return {
            id: m.id,
            type: m.type,
            label,
            detail: m.content,
            importance: m.importance,
            created_at: m.created_at,
            tags: m.tags,
          };
        });

        const edges = relations.map((r) => ({
          source: r.source_id,
          target: r.target_id,
          relation: r.relation_type,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ nodes, edges }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/identity') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ service: 'claude-memory', cwd: process.cwd() }));
      return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = resolveGraphHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(GRAPH_PORT, '127.0.0.1', () => {
    // Log to stderr so it doesn't interfere with MCP stdio
    process.stderr.write(`Memory graph available at http://localhost:${GRAPH_PORT}\n`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`Warning: port ${GRAPH_PORT} already in use, memory graph HTTP server not started\n`);
    } else {
      process.stderr.write(`Warning: HTTP server error: ${err.message}\n`);
    }
  });
}

async function main() {
  const dbPath = resolveDbPath();
  const db = new MemoryDatabase(dbPath);

  const server = new McpServer({
    name: 'claude-memory',
    version: '1.2.0',
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

  startHttpServer(db);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start claude-memory server:', err);
  process.exit(1);
});
