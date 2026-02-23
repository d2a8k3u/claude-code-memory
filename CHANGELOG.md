# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.3]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.3
[0.1.2]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.2
[0.1.1]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.1
[0.1.0]: https://github.com/d2a8k3u/claude-code-memory/releases/tag/v0.1.0
