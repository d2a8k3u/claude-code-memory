---
name: memory-init
description: >
  Bootstrap the project memory by scanning the codebase. Reads key project
  files (CLAUDE.md, README, package.json, directory structure, CI configs,
  git history) and creates an initial memory base. Run once when first
  installing the plugin on a project, or to refresh the baseline.
argument-hint: "[optional: focus area like 'backend only' or 'just the API']"
---

# Project Memory Bootstrap

Scan the current project and populate the memory with foundational knowledge. This gives Claude an informed starting point instead of beginning from scratch.

## Discovery Steps

Perform these steps in order. For each step, read the relevant files, extract key information, and store it using `memory_store` or `memory_store_batch`.

### 1. Project Identity

Look for and read:
- `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json`
- `README.md`, `README`
- `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle`

Store as **semantic** memories with titles:
- Project name and description
- Programming language(s) and framework(s)
- Key dependencies and their purposes
- Version requirements

### 2. Project Structure

Run a directory listing (top 2-3 levels) and analyze the layout.

Store as **semantic** memories with titles:
- High-level architecture (monorepo, monolith, microservices, etc.)
- Key directories and their purposes
- Entry points and main modules

### 3. Build, Test & Run

Look for and read:
- `package.json` scripts section
- `Makefile`, `Taskfile.yml`, `justfile`
- `Dockerfile`, `docker-compose.yml`
- CI configs: `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`

Store as **procedural** memories:
- How to install dependencies
- How to build the project
- How to run tests
- How to start the dev server
- How to deploy (if CI config is present)

### 4. Conventions & Patterns

Look for and read:
- `CLAUDE.md` (coding conventions, rules)
- `.eslintrc`, `.prettierrc`, `biome.json`, `ruff.toml`
- `tsconfig.json`, `.editorconfig`
- `.env.example`, `.env.template`

Store as **pattern** memories with titles:
- Code style conventions (formatting, naming)
- Linting rules and their rationale
- Environment variables and their purposes
- TypeScript/compiler configuration choices

### 5. Architecture Decisions

Look for and read:
- `CLAUDE.md` (architectural notes)
- `docs/`, `ADR/`, `architecture/` directories
- README sections about architecture

Store as **semantic** memories with title and tag "decision":
- Technology choices and their rationale
- Design patterns used in the project
- Important constraints or trade-offs

### 6. Recent Activity

Check git history:
- Last 10-20 commits (messages and files changed)
- Active branches

Store as **episodic** memories:
- Summary of recent work and focus areas
- Active development areas

### 7. Create Relations

After creating all memories, link related items using `memory_relate`:
- Tech stack facts → architecture decisions (`implements`)
- Build procedures → project structure (`depends_on`)
- Conventions → tech stack (`derived_from`)
- Related facts → each other (`relates_to`)

## Guidelines

1. **Don't duplicate** — Before storing, check with `memory_search`. Update existing items instead of creating duplicates.
2. **Be concise** — Store essential facts, not raw file contents.
3. **Set appropriate scores**:
   - Project identity facts → importance 0.9
   - Build/test procedures → importance 0.8
   - Conventions and patterns → importance 0.8
   - Recent activity → importance 0.5
4. **Tag consistently** — Use tags like `tech-stack`, `build`, `deploy`, `testing`, `conventions`, `architecture`, `git-history`.
5. **Note the source** — Set the `source` field to the file path where the information came from.
6. **Respect focus** — If the user specified a focus area, limit discovery to that area.
7. **Report results** — At the end, summarize what was discovered and stored:
   - Number of memories created (by type)
   - Number of relations created
   - Key findings and any gaps noticed

$ARGUMENTS
