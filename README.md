# Claude Code Memory

A [Claude Code](https://claude.ai/download) plugin that gives Claude fully automatic, per-project cognitive memory — powered by local embeddings and hybrid search.

## Features

- **Auto-loads** relevant context at session start using git signals (branch, commits, modified files)
- **Auto-saves** a structured session summary when the session ends
- **Auto-recalls** matching memories when Bash errors occur
- **Auto-merges** near-duplicate memories on store (≥95% cosine similarity)
- **Auto-consolidates** every 10 sessions — reviews duplicates, stale entries, and emerging patterns

All data stays local. Everything is scoped to the current project via the working directory.

## Requirements

- Node.js >= 18
- [Claude Code](https://claude.ai/download) CLI

## Installation

```bash
git clone https://github.com/d2a8k3u/claude-code-memory.git claude-memory
cd claude-memory
./install.sh
```

The installer builds the MCP server, registers it globally, adds hooks to `~/.claude/settings.json`, and symlinks skills. **Restart Claude Code after installation.**

> **Note:** On first use, the plugin downloads a ~90 MB embedding model ([all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)) from Hugging Face. This happens once and is cached locally. The first session start may take 10-30 seconds depending on your connection.

### First-run bootstrap (optional)

Run `/memory-init` in any project to populate the memory from existing project files (README, package.json, CLAUDE.md, git history, etc.).

## How It Works

### Session Lifecycle

1. **SessionStart** — clears working memories, decays stale importance, injects relevant context from the memory DB
2. **During session** — Claude uses 9 MCP tools automatically (store, search, get, update, delete, list, batch-store, relate, graph)
3. **PostToolUse** — on Bash errors, extracts error terms and surfaces matching memories
4. **Stop** — analyzes the session transcript and saves a structured episodic summary

### Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| `episodic` | What happened | "Fixed auth bug — missing null check on refresh token" |
| `semantic` | Project facts | "API uses JWT with refresh token rotation, tokens in Redis" |
| `procedural` | How-to | "Deploy: merge to develop, CI builds, auto-deploy to staging" |
| `working` | Session scratchpad | Hypotheses, intermediate results (auto-cleared next session) |
| `pattern` | Consolidated insights | "Error handling: always use Result types with typed errors" |

Memories can be linked with relations: `relates_to`, `depends_on`, `contradicts`, `extends`, `implements`, `derived_from`.

### Search

Hybrid search combining FTS5 full-text and semantic vectors (cosine similarity via sqlite-vec). Falls back to text-only when embeddings are unavailable.

### Storage

SQLite database at `.claude/memory-db/memory.sqlite` inside each project. Includes FTS5 and vec0 virtual tables for fast search.

<details>
<summary>Architecture</summary>

```
claude-memory/
├── install.sh                    # Installer
├── server/src/
│   ├── index.ts                  # MCP server entry point
│   ├── cli.ts                    # Hook runner entry point
│   ├── database.ts               # SQLite + FTS5 + vec0
│   ├── memory.ts                 # 9 MCP tool handlers
│   ├── embeddings.ts             # Local embeddings (all-MiniLM-L6-v2, 384-dim)
│   └── cli/                      # Hook handlers (session-start, session-end, error-context)
├── skills/memory-init/           # /memory-init bootstrap skill
├── agents/memory-curator.md      # Maintenance sub-agent
└── hooks/hooks.json.template     # Reference hook config
```

</details>

## Tech Stack

TypeScript · MCP SDK · better-sqlite3 · sqlite-vec · @huggingface/transformers · Zod · tsup

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
