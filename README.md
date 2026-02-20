# Claude Code Memory

A Claude Code plugin that gives Claude fully automatic, per-project cognitive memory.

## What It Does

- **Remembers** previous sessions (episodic), project facts (semantic), procedures (procedural), and consolidated insights (pattern)
- **Auto-loads** relevant context at session start using git signals (branch, commits, modified files)
- **Auto-saves** structured session summaries at session end
- **Auto-recalls** relevant memories when Bash errors occur
- **Auto-consolidates** every 10 sessions (decay, dedup, pattern extraction)
- **Auto-merges** near-duplicate memories on store (>97% similarity)

Everything is scoped to the current project.

## Installation

```bash
git clone <repo-url> claude-memory
cd claude-memory
./install.sh
```

Then in any project:

```bash
claude --plugin-dir /path/to/claude-memory
```

On first use, bootstrap the memory from project files:

```
/claude-memory:memory-init
```

## How It Works

### Session Lifecycle

1. **SessionStart hook** — clears working memories, decays stale importance, FTS-searches git signals against the memory DB, injects relevant context + behavioral instructions
2. **During session** — Claude uses 9 MCP tools automatically based on injected instructions (store, search, get, update, delete, list, batch store, relate, graph)
3. **PostToolUse hook** — on Bash errors, extracts error terms and injects matching memories as context
4. **Stop hook** — analyzes transcript, saves structured episodic summary (task, tools, files, errors)

### Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| `episodic` | What happened | "Fixed auth bug — missing null check on refresh token" |
| `semantic` | Project facts | "API uses JWT with refresh token rotation, tokens in Redis" |
| `procedural` | How-to | "Deploy: merge to develop, CI builds, auto-deploy to staging" |
| `working` | Session scratchpad | Hypotheses, intermediate results (auto-cleared next session) |
| `pattern` | Consolidated insights | "Error handling: always use Result types with typed errors" |

### Relations

Memories can be linked: `relates_to`, `depends_on`, `contradicts`, `extends`, `implements`, `derived_from`.

Patterns are typically linked to their source memories via `derived_from`.

## Architecture

```
claude-memory/
├── .claude-plugin/
│   └── plugin.json               # Plugin manifest
├── .mcp.json.template            # MCP server config (template)
├── install.sh                    # Installs deps, builds, generates configs
├── server/
│   ├── src/
│   │   ├── index.ts              # MCP server entry point
│   │   ├── database.ts           # SQLite + FTS5 + vec0
│   │   ├── memory.ts             # 9 MCP tools
│   │   ├── embeddings.ts         # Local embeddings (all-MiniLM-L6-v2, 384-dim)
│   │   ├── types.ts              # TypeScript types
│   │   └── database.test.ts      # Tests
│   ├── package.json
│   └── tsconfig.json
├── hooks/
│   ├── hooks.json.template       # Hook definitions (template)
│   └── scripts/
│       ├── lib/db.js             # Shared DB utilities for hooks
│       ├── session-start.js      # Git-aware context + cleanup + instructions
│       ├── session-end.js        # Structured session summary
│       └── post-tool-use.js      # Bash error recall
├── skills/
│   └── memory-init/SKILL.md      # Bootstrap from project files
└── agents/
    └── memory-curator.md         # Maintenance agent (Haiku)
```

### Search

Hybrid: FTS5 full-text + semantic vectors (cosine similarity via vec0). Ranked by `text * 0.5 + importance * 0.2 + recency * 0.2 + access_freq * 0.1`. Falls back to FTS-only when embeddings are unavailable.

### Data Model

```
memories:  id, type, title, content, context, source, tags,
           importance, created_at, updated_at, access_count,
           last_accessed, embedding
relations: source_id, target_id, relation_type, weight
meta:      key, value
```

Plus `memories_fts` (FTS5) and `memories_vec` (vec0) virtual tables.

## Tech Stack

TypeScript, MCP SDK, better-sqlite3, sqlite-vec, `@huggingface/transformers`, Zod, ULID, tsup. Node.js >= 18.

## License

MIT
