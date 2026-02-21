# Claude Code Memory

A Claude Code plugin that gives Claude fully automatic, per-project cognitive memory.

## What It Does

- **Remembers** previous sessions (episodic), project facts (semantic), procedures (procedural), and consolidated insights (pattern)
- **Auto-loads** relevant context at session start using git signals (branch, commits, modified files)
- **Auto-saves** a structured session summary at session end
- **Auto-recalls** relevant memories when Bash errors occur
- **Auto-consolidates** every 10 sessions — Claude reviews and cleans up duplicates, stale entries, and emerging patterns
- **Auto-merges** near-duplicate memories on store (≥95% cosine similarity)

Everything is scoped to the current project via the working directory.

## Requirements

- Node.js >= 18
- [Claude Code](https://claude.ai/download) CLI

## Installation

```bash
git clone <repo-url> claude-memory
cd claude-memory
./install.sh
```

The installer:
1. Builds the MCP server (`server/dist/`)
2. Registers it globally via `claude mcp add --scope user`
3. Adds three hooks to `~/.claude/settings.json` (SessionStart, PostToolUse, Stop)
4. Grants MCP tool permissions in `~/.claude/settings.json`
5. Symlinks skills into `~/.claude/skills/`

**Restart Claude Code after installation.** The plugin is then globally active in every project.

### First-run bootstrap (optional)

On a new project, run the skill to populate the memory from existing project files:

```
/memory-init
```

This reads your README, package.json, CLAUDE.md, git history, and other key files to give Claude an informed starting point.

## How It Works

### Session Lifecycle

1. **SessionStart hook** — clears working memories, decays stale importance, searches git signals (branch, commits, modified files) against the memory DB, injects relevant context and behavioral instructions into the system prompt
2. **During session** — Claude uses 9 MCP tools automatically based on injected instructions (store, search, get, update, delete, list, batch-store, relate, graph)
3. **PostToolUse hook** — after each Bash tool call, if an error occurred, extracts error terms and injects matching memories as additional context
4. **Stop hook** — analyzes the session transcript and saves a structured episodic summary (task, tools used, files touched, errors encountered)

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
├── install.sh                    # Installs deps, builds, registers MCP + hooks + skills
├── server/
│   ├── src/
│   │   ├── index.ts              # MCP server entry point
│   │   ├── cli.ts                # Hook runner entry point
│   │   ├── database.ts           # SQLite + FTS5 + vec0
│   │   ├── memory.ts             # 9 MCP tools
│   │   ├── embeddings.ts         # Local embeddings (all-MiniLM-L6-v2, 384-dim)
│   │   ├── types.ts              # TypeScript types
│   │   ├── cli/
│   │   │   ├── session-start.ts  # Git-aware context injection + cleanup
│   │   │   ├── session-end.ts    # Structured session summary
│   │   │   ├── error-context.ts  # Bash error recall
│   │   │   ├── git-signals.ts    # Branch/commit/file signal extraction
│   │   │   ├── transcript.ts     # Session transcript parser
│   │   │   └── types.ts          # Hook I/O types
│   │   └── __tests__/            # Test suite
│   ├── package.json
│   └── tsconfig.json
├── skills/
│   └── memory-init/SKILL.md      # /memory-init skill — bootstrap from project files
├── agents/
│   └── memory-curator.md         # Memory maintenance sub-agent (Haiku)
└── hooks/
    └── hooks.json.template       # Reference hook config template
```

### Search

Hybrid: FTS5 full-text + semantic vectors (cosine similarity via vec0). Ranked by `text_score * 0.5 + importance * 0.2 + recency * 0.2 + access_freq * 0.1`. Falls back to FTS-only when embeddings are unavailable.

### Data Model

```
memories:  id, type, title, content, context, source, tags,
           importance, created_at, updated_at, access_count,
           last_accessed, embedding
relations: source_id, target_id, relation_type, weight
meta:      key, value
```

Plus `memories_fts` (FTS5) and `memories_vec` (vec0) virtual tables.

The database lives at `.claude/memory-db/memory.sqlite` inside each project.

## Tech Stack

TypeScript · MCP SDK · better-sqlite3 · sqlite-vec · @huggingface/transformers · Zod · ULID · tsup · Node.js ≥ 18

## License

MIT
