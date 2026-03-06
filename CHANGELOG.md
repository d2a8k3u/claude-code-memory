# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-06

### Added

- **Cross-encoder reranking** — `memory_search` now reranks results with a TinyBERT cross-encoder (ms-marco-TinyBERT-L-2-v2) for significantly more accurate relevance scoring. Over-fetches 3x candidates, reranks, then slices to requested limit. Graceful fallback if model unavailable.
- **Relevance filtering with strictness levels** — new `strictness` parameter on `memory_search` (`low`, `normal`, `high`) controls minimum topic and relevance thresholds, filtering out noise before results reach the caller
- **Topic splitter** — automatic decomposition of large multi-topic memories into focused, single-topic units
  - Splits by H2/H3 headers, **bold-colon** patterns, and numbered bold items
  - Validates preambles, filters short sections
  - Integrated into `memory_store`, `memory_store_batch`, and session-end consolidation
- **Merge utilities module** (`merge-utils.ts`) — extracted reusable merge logic: tag normalization, safe JSON parsing, intelligent merge updates
- **Reorganize command** — new `node dist/cli.js reorganize` subcommand for batch splitting of large memories with relation preservation and accumulative record deduplication
- **Memory reorganize skill** — guided manual reorganization workflow (5-step process)
- **Memory cleanup skill** — guided cleanup workflow: deduplicates accumulative records (tech-stack, active-modules), consolidates near-duplicate episodics, removes junk procedurals and low-value patterns
- **Tag-based memory lookup** — `findMemoryByTag()` for efficient singleton record retrieval (used by session-end for accumulative records)
- **Type-filtered deduplication** — `findSimilarMemory()` now accepts optional type parameter for more precise duplicate detection
- **Database transaction helper** — `transaction()` wrapper for atomic multi-step operations
- **Auto-split during consolidation** — session-start consolidation now splits up to 5 large memories per run
- **Reranker model warmup** — pre-loads cross-encoder at session start alongside embedding model

### Changed

- **Search scoring overhaul** — FTS/vector blending now uses signal-aware logic: FTS-only matches use full FTS score instead of being diluted by 0.4 weight when no vector match exists. FTS match floor (0.05) prevents common-term IDF collapse from hiding relevant results.
- **Session-end singleton records** — tech-stack and active-modules are now merged in-place via tag lookup instead of creating duplicates every session. Procedural workflows similarly update-or-create by category.
- **Session-end episodic filtering** — skips meaningless records (short tasks, interrupted requests with no substance) to reduce noise
- **Pattern clustering improvements** — consolidation now filters cluster candidates to session-end records only and excludes interrupted sessions
- `memory_store` now calls topic splitter before storage, with type-filtered dedup and contradiction detection
- `memory_store_batch` pre-expands splittable items (cap: 100) with within-batch and DB deduplication, plus sibling relations
- Session-start uses relevance thresholds to filter injected context (topic: 0.08, relevance: 0.15)
- Tool descriptions updated to instruct English-only content for consistent cross-language retrieval
- Consolidation excludes `pattern` type from auto-splitting (only splits semantic and procedural)

## [0.2.0] - 2026-02-24

### Added

- **Auto-creation of memory types** — session-end hook now creates procedural, semantic, and pattern memories automatically, not just episodic
  - **Procedural**: extracted from successful bash command sequences (build, test, lint, deploy workflows) when 2+ related commands run in a session
  - **Semantic**: technology stack detection from commands and file extensions, active module detection from modified file paths
  - **Pattern**: clustering of similar episodic memories (3+ with cosine similarity 0.40–0.95) with `derived_from` relations to source memories
- **Automated consolidation** — replaces the prompt-based "Consolidation Due" that Claude ignored
  - Merges near-duplicate memory pairs (cosine distance < 0.08, same type)
  - Detects patterns across all recent episodics
  - Deletes truly stale memories (importance < 0.1, access_count = 0, age > 60 days, excludes pattern/procedural)
  - Runs every 10 sessions, reports results in session header (e.g. "3 duplicates merged, 1 stale deleted")
- Enriched transcript parsing: bash command tracking with success/failure correlation via tool_use_id, files read, technology detection
- New database methods: `getRecentEpisodicWithEmbeddings`, `getMemoriesByTypeWithEmbeddings`, `mergeMemories`, `findNearDuplicatePairs`, `deleteStaleMemories`
- Shared utilities module (`shared.ts`): `makeMemoryRecord`, `derivePatternTitle`, `STOP_WORDS`
- Auto-created records tagged distinctively: `auto-procedural`, `auto-semantic`, `auto-pattern`

### Changed

- Session-end now batches all embeddings in a single `generateEmbeddings()` call instead of sequential `generateEmbedding()` calls
- Session-end deduplicates new procedural/semantic records against existing memories before insertion (cosine distance < 0.05)
- CLAUDE.md instructions updated: documents auto-saved memory types, repositions manual `memory_store` as supplementary for insights automation might miss

## [0.1.3] - 2026-02-23

### Improved

- Add behavioral reminder to session-start hook output — explicitly tells Claude that passive context is not a substitute for active `memory_search`
- Strengthen CLAUDE.md instructions: emphasize proactive recall during work (not just at task start), so users never have to say "check your memory"

## [0.1.2] - 2026-02-22

### Fixed

- Handle nested `message` field in session transcript parsing

## [0.1.1] - 2026-02-21

### Fixed

- Add error logging to embedding generation (previously silent failures)
- Fix unquoted shell variables in install script `node -e` blocks

### Added

- Uninstall script (`uninstall.sh`)
- CHANGELOG

## [0.1.0] - 2025-02-21

Initial release of claude-code-memory.

### Added

- MCP server with 9 memory tools (store, search, batch store, get, update, delete, relate, graph, health)
- SQLite database with WAL mode, FTS5 full-text search, and vec0 vector extension
- Hybrid search combining FTS5 text matching and vector similarity (384-dim local embeddings)
- 5 memory types: episodic, semantic, procedural, working, pattern
- Knowledge graph with 6 relation types and traversal up to depth 3
- Relevance scoring: text (0.5) + importance (0.2) + recency (0.2) + access frequency (0.1)
- Claude Code hooks: session-start (git signal context injection), session-end (episodic summaries), error-context (memory search on failures)
- Batch merge deduplication and contradiction auto-linking
- Importance decay for stale memories
- WAL checkpoint on database close
- Embedding model warmup for faster first-search performance
- Memory-init skill for bootstrapping project knowledge from codebase
- Memory-curator agent (Haiku-powered) for automated maintenance
- Install script with MCP server registration, skills, hooks, and permissions setup
- MIT license

[1.0.0]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v1.0.0
[0.2.0]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.2.0
[0.1.3]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.3
[0.1.2]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.2
[0.1.1]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.1
[0.1.0]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.0
