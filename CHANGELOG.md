# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-06-23

### Added

- **`/memory-graph` slash command** — opens the memory graph visualization in the user's default browser at `http://localhost:7337`. The visualization is served by the MCP server's built-in HTTP server and renders all stored memories as a navigable, searchable graph with type filters and draggable nodes. The command performs an identity check via the new `GET /api/identity` endpoint before opening the browser, so when port 7337 is held by another claude-memory project (or a different application), the user is told which session to close instead of being silently shown the wrong project's graph. Installed globally by `install.sh` via symlink into `~/.claude/commands/`.
- **Autonomous cognitive memory loop** — new hooks replace reliance on Claude's discretion for routine memory ops:
  - `UserPromptSubmit` hook runs three parallel type-scoped searches (semantic, pattern, and — when the prompt is recall-style — episodic) on every user message, injecting up to 6 compact matches.
  - `PreToolUse` hook with per-tool dispatch: `Edit`/`Write` surfaces patterns as warning blocks; `Bash` looks up canonical workflows; `Read`/`Grep`/`Glob` injects semantic+episodic; `WebFetch`/`WebSearch` catches "we already researched this".
  - Stop hook (`session-end`) now runs a turn-extractor: captures user corrections as `pattern` memories, discovers new module/tech facts as `semantic`, and triggers incremental pattern promotion.
- **Relation graph grows over time**:
  - `insertWithAutoRelations` funnel — every write path (MCP, SessionEnd, Stop, and internal) goes through one function that validates content, dedups, and creates up to 5 auto-relations (contradicts / extends / relates_to / derived_from).
  - Co-activation counter (`relation_coactivations` table) — co-injected memories promote to `relates_to` after 3 co-injections.
  - Periodic relation sweep — every 20 sessions, under-connected nodes are re-examined via vec0 nearest-neighbour search to discover missed connections (500 ms budget, 100 candidates).
  - Relation weight evolution — decay per session, boost on co-injection, boost on co-access, stale-prune when weight < 0.05 and endpoints are unused.
- **Type-aware retrieval and decay**:
  - `TYPE_RELEVANCE`, `TYPE_LIMITS_PER_HOOK`, `TYPE_DECAY`, `TYPE_BOOST_ON_INJECT`, `TYPE_BOOST_ON_ACCESS`, `RELATION_WEIGHT` constants.
  - Pattern memories decay slowest (−0.01/session) and boost fastest (+0.04 on inject, +0.08 on access); episodics fade fastest (−0.08); semantic and procedural never auto-delete.
- **Compact injection format** — shared `injection-format` module produces uniform, markdown-stripped output with high-importance patterns starred (`★`) and dated episodics. Warning block variant for `Edit`/`Write` pre-tool-use.
- **Cluster-aware retrieval** — `relation-walk` module pulls in 1-hop neighbours (weight ≥ 0.5) alongside primary matches; neighbours appear indented under their primary with the relation type.
- **Cross-hook dedup** — `session-cache.json` sidecar tracks IDs injected this session; subsequent hooks skip them (FIFO cap at 200).
- **Classifier + recall detector** — heuristic modules for memory-type inference and detecting when a prompt is asking "have we done X?".
- **`cli cleanup --rewrite-titles`** — idempotent migration command that rewrites legacy `**Task:**`-prefix episodics into prose titles + content.
- **Extended `memory_health`** — new Relation Graph section with link density, isolated nodes, avg relation weight, strong-relation share, and last sweep session.
- `relation_coactivations` sidecar table (additive schema change; no migration needed for existing installs).
- **`/memory-recall` slash command** — per-project kill-switch that pauses or resumes automatic recall while leaving storing active. Writes a per-project flag the hooks honour; injection is skipped while recall is off.
- **`/memory-status` slash command** — on-demand memory health digest (item counts, sessions, injections served), sharing a single `health-report` module with the `memory_health` tool.
- **Statusline badge** — optional `statusLine` rendering `🧠 <injected> loaded / <corpus>`. `install.sh` sets it only when no statusline is already configured (never clobbers an existing one). The reader keys off a precomputed flat file (`.claude/memory-db/.statusline`), so it never opens the database.
- **Schema migrations + stale-fact suppression** — additive migration runner replaces the single-schema assumption; semantic facts that are superseded/contradicted are suppressed from recall instead of surfacing next to their replacement.
- **Importance reinforcement via reply co-occurrence** — a memory injected and then echoed in the user's next reply gains importance, so genuinely-used memories rise over unused ones.
- **Escalated framing for repeatedly-recalled patterns** — a pattern surfaced across many sessions is reframed as a stronger "apply this or state why it does not apply" directive rather than being silently re-shown.

### Changed

- **`SessionStart` output slimmed** from up to 25 items to ≤ 10; behavioural-reminder block removed (ineffective across 7+ sessions; replaced by the hook-driven loop).
- **`SessionEnd` episodic content is now prose** — no `**Task:**` / `**Files:**` / `**Tools:**` meta-prefixes. Content leads with the task summary as a sentence followed by factual detail.
- **MCP `memory_store`** now routes through `insertWithAutoRelations`, ensuring consistent dedup, relation-creation, and content quality across every write path.
- **Consolidation moves from a 10-session batch to continuous event-triggered subroutines** — dedup on insert, pattern promotion on Stop, decay per SessionStart.
- Per-type decay replaces the flat `decayImportance(30, 0.05)` call.
- **Recalled patterns render as actionable directives** — pattern/correction memories are shown as an `Apply —` directive and no longer truncated mid-rule; the pre-edit warning block now demands the rule be applied or explicitly dismissed before continuing. `CLAUDE_MEMORY.md` (written by `install.sh`) gains an "Act on what surfaces" section.
- **Episodic recall is always-on but topically gated** — every prompt runs a type-scoped episodic search gated by topical relevance, instead of only recall-style prompts.
- **`SessionStart` treats compaction and resume as continuation** — `source = compact|resume` is handled as an ongoing session rather than re-injecting a full cold-start payload.
- **`error-context` uses hybrid retrieval with FTS fallback** — semantic + full-text search with graceful degradation when embeddings are unavailable.
- **Reduced auto-save and recall noise** — tighter thresholds and filtering cut low-value episodic writes and redundant injections.
- **Refactored `CLAUDE.md` / memory-files setup** in `install.sh` for cleaner install and update handling.

### Removed

- The "you MUST call memory_search" behavioural reminder block at SessionStart.
- Meta-prefix formatting (`**Task:**` etc.) from auto-saved episodic content.
- Fixed 25-item `SessionStart` cap.

### Fixed

- **Hook template aligned with the installed five-hook set** — the reference template defined only 3 events (`SessionStart`, `PostToolUse`, `Stop`) with an object-form matcher, while `install.sh` installs 5 (adding `UserPromptSubmit` and `PreToolUse`) with a string matcher. Loading from the stale template silently dropped the prompt-submit and pre-tool-use hooks; the template now matches the 5 events and the `"Bash"` string matcher.

## [1.1.0] - 2026-03-15

### Added

- **Adaptive context budget allocation** — replaces fixed per-section caps with a two-phase system: phase 1 fills per-section minimums, phase 2 pools remaining candidates by quality score. Total budget of 25 items is distributed dynamically based on available high-quality results.
- **Centralized threshold configuration** (`thresholds.ts`) — all similarity thresholds, scoring weights, decay parameters, and archival criteria in a single source of truth. Replaces magic numbers scattered across 6+ files.
- **Shared pattern detector** (`pattern-detector.ts`) — extracted clustering logic from both session-start and session-end into a single module. Includes cluster quality scoring (minimum intra-cluster similarity 0.55).
- **Per-channel scoring weight presets** — search channels can specify custom scoring weights. Branch queries favor recency (`textScore: 0.4, recency: 0.35`), CWD queries favor importance (`importance: 0.3`).
- **Two-phase recency scoring** — steep decay for days 0–7 (strongly favors recent work), gradual exponential decay for 7+ days (τ=120). Replaces the uniform `exp(-age/90)` curve.
- **Content-length penalty** — memories longer than 500 characters receive a score penalty (up to -0.15), preventing verbose generic memories from dominating results.
- **Noise tool filtering** — transcript processing now filters out trivial tool calls (Read, Glob, Grep, Bash ls/cat) when assessing session substance.
- **Task deduplication** — session-end deduplicates near-identical task summaries before creating episodic records.
- **Commit message extraction** — git signal extraction now preserves full commit messages as search queries instead of splitting into individual words.
- **Activity-weighted consolidation trigger** — consolidation now triggers based on cumulative session weight (tool calls, file modifications, memory operations) instead of raw session count. Fallback to every 20 sessions if weight tracking is unavailable.
- **Memory metrics in health** — `memory_health` now reports injection counts, scoring distribution, and embedding coverage statistics.

### Changed

- **Removed importance auto-boost** — search hits and merges no longer inflate importance. Importance now reflects stored value only and decays naturally. Fixes the positive feedback loop where generic memories monotonically climbed toward the 0.95 cap.
- **Tightened episodic dedup** — threshold changed from 0.10 to 0.08 cosine distance, matching the consolidation merge threshold.
- **Tightened pattern clustering** — similarity window narrowed from 0.40–0.95 to 0.50–0.85. Clusters must meet minimum quality (avg similarity > 0.55). Weak clusters produce lower-importance patterns.
- **More aggressive episodic archival** — age threshold reduced from 90 to 60 days, importance threshold from 0.7 to 0.4, access threshold from 3 to 1.
- **Session-end substance scoring** — sessions with < 3 non-trivial tool calls and no file modifications are skipped for episodic creation. Reduces low-value records like "Task: Hello".
- **Skills consolidated** — `memory-cleanup` and `memory-reorganize` merged into a single `/memory-maintain` skill covering deduplication, consolidation, junk cleanup, and memory splitting.
- Tests increased from 223 to 336 — new coverage for budget allocation, pattern detection, noise filtering, scoring weights, and recency curves.

### Removed

- `memory-cleanup` skill (merged into `memory-maintain`)
- `memory-reorganize` skill (merged into `memory-maintain`)
- Importance auto-boost on search hits (+0.02) and merges (+0.05)

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

[1.1.0]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v1.1.0
[1.0.0]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v1.0.0
[0.2.0]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.2.0
[0.1.3]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.3
[0.1.2]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.2
[0.1.1]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.1
[0.1.0]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.0
