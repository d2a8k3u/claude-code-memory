# Claude Code Memory

A [Claude Code](https://claude.ai/download) plugin that gives Claude fully automatic, per-project cognitive memory — powered by local embeddings and hybrid search.

## Features

- **Autonomous hook loop (v1.2)** — the plugin searches memory on every user prompt, before every file edit, before every Bash command, and when Claude uses Read/Grep/WebFetch. Claude doesn't need to remember to call `memory_search`.
- **Auto-saves** per turn with a prose summary (no meta-prefix boilerplate); user corrections automatically become `pattern` memories.
- **Auto-recalls** matching memories when Bash errors occur.
- **Auto-merges** near-duplicate memories on store (≥95% cosine similarity) and **auto-creates relations** on every write path.
- **Relation graph grows over time** — co-injected memories promote to `relates_to`; a periodic sweep (every 20 sessions) finds connections missed at insert time; relation weights evolve with usage.
- **Type-aware decay** — patterns decay slowly and boost aggressively on recall; episodics fade fast; semantic and procedural are permanent unless you delete them.
- **Cluster-aware retrieval** — when a memory is injected, its strongest neighbours (weight ≥ 0.5) come along.
- **Compact, markdown-stripped injection format** — no section headers; one line per memory with high-importance patterns starred.

## How Claude uses memory

| When this happens | The plugin does |
|---|---|
| You send a prompt | Searches semantic, pattern, and (if recall-style) episodic memory in parallel; injects ≤ 6 compact matches. |
| Claude is about to Edit/Write a file | Surfaces any pattern memory scoped to that file as a warning. |
| Claude is about to run a Bash command | Looks up the canonical workflow for that command category (build/test/deploy/…). |
| Claude Grep/Read/Globs | Injects semantic + episodic context scoped to the path. |
| A Bash command fails | Pulls relevant error-context memory. |
| The assistant turn ends | Runs the turn-extractor; stores user corrections as patterns, new facts as semantic; promotes recurring clusters to patterns. |

Claude still has direct access to the MCP tools (`memory_store`, `memory_relate`, `memory_update`, etc.) for judgement-level work — explicit "remember this" requests, overrides, or corrections to auto-saved memories.

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

1. **SessionStart** — clears working memories, decays stale importance, injects relevant context via adaptive budget allocation
2. **During session** — Claude uses 10 MCP tools automatically (store, search, get, update, delete, list, batch-store, relate, graph, health)
3. **PostToolUse** — on Bash errors, extracts error terms and surfaces matching memories
4. **Stop** — analyzes the session transcript with noise filtering and saves structured memories (episodic, procedural, semantic, pattern)

### Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| `episodic` | What happened | "Fixed auth bug — missing null check on refresh token" |
| `semantic` | Project facts | "API uses JWT with refresh token rotation, tokens in Redis" |
| `procedural` | How-to | "Deploy: merge to develop, CI builds, auto-deploy to staging" |
| `working` | Session scratchpad | Hypotheses, intermediate results (auto-cleared next session) |
| `pattern` | Consolidated insights | "Error handling: always use Result types with typed errors" |

Memories can be linked with relations: `relates_to`, `depends_on`, `contradicts`, `extends`, `implements`, `derived_from`.

### Search & Scoring

Hybrid search combining FTS5 full-text and semantic vectors (cosine similarity via sqlite-vec). Falls back to text-only when embeddings are unavailable. Results are reranked with a cross-encoder (ms-marco-TinyBERT-L-2-v2) for accurate relevance scoring.

Scoring combines text relevance, importance, recency, and access frequency with configurable per-channel weight presets (e.g. branch queries favor recency, project-level queries favor importance). Verbose memories receive a content-length penalty to keep results focused.

### Storage

SQLite database at `.claude/memory-db/memory.sqlite` inside each project. Includes FTS5 and vec0 virtual tables for fast search.

### Skills & Commands

| Command | Description |
|---------|-------------|
| `/memory-init` | Bootstrap project memory from codebase files (README, package.json, git history, etc.) |
| `/memory-maintain` | Deduplicate, consolidate, clean junk records, and split large memories |
| `/memory-graph` | Open the memory graph visualization in your browser at `http://localhost:7337` |

<details>
<summary>Architecture</summary>

```
claude-memory/
├── install.sh                    # Installer
├── server/src/
│   ├── index.ts                  # MCP server entry point
│   ├── cli.ts                    # Hook runner entry point
│   ├── database.ts               # SQLite + FTS5 + vec0
│   ├── memory.ts                 # 10 MCP tool handlers
│   ├── embeddings.ts             # Local embeddings (all-MiniLM-L6-v2, 384-dim)
│   ├── thresholds.ts             # Centralized similarity/scoring configuration
│   └── cli/
│       ├── session-start.ts      # Budget allocation, context injection
│       ├── session-end.ts        # Transcript analysis, memory creation
│       ├── error-context.ts      # Error pattern matching
│       ├── pattern-detector.ts   # Shared pattern clustering logic
│       └── transcript.ts         # Transcript parsing with noise filtering
├── skills/
│   ├── memory-init/              # /memory-init bootstrap skill
│   └── memory-maintain/          # /memory-maintain cleanup skill
├── commands/
│   └── memory-graph.md           # /memory-graph slash command
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
