---
name: memory-maintain
description: >
  Maintain memory database — deduplicate accumulative records, consolidate
  near-duplicate episodics, remove junk procedurals and low-value patterns,
  and split large multi-topic memories into focused units.
argument-hint: "[optional: 'dedup only', 'episodic only', 'split only', 'full']"
---

# Memory Maintenance

Clean up noise, deduplicate records, and reorganize large memories. Run this after upgrading the plugin, when search quality degrades, or when memories have grown large and unfocused.

## Steps

### 1. Assess

Run `memory_health` to get current counts, types, and staleness stats.

### 2. Deduplicate accumulative records

These records should exist at most once each. Search for duplicates and merge them.

**Tech-stack:**
1. `memory_search("Technology stack used", type="semantic")`
2. If multiple records have the `tech-stack` tag AND content starts with `Technology stack used:`:
   - Collect all technology items from each record's comma-separated list
   - `memory_update` the most comprehensive record with the union of all items (sorted alphabetically)
   - `memory_delete` all other duplicates
3. **Tag collision check:** If any record has the `tech-stack` tag but does NOT start with `Technology stack used:` (e.g., a detailed dependencies description from memory-init), rename its tag from `tech-stack` to `tech-stack-detail` via `memory_update` to prevent merge conflicts.

**Active modules:**
1. `memory_search("Active modules directories", type="semantic")`
2. If multiple records have the `active-modules` tag AND content starts with `Active modules/directories:`:
   - Same approach: union all items, update the best, delete the rest
3. **Tag collision check:** Same as above — rename non-accumulative records' tag to `active-modules-detail`.

### 3. Consolidate episodic records

1. `memory_list(type="episodic", limit=50)` — scan through all episodic records
2. **Delete meaningless records** that match ANY of:
   - Task is `[Request interrupted by user for tool use]` with no tools AND no files AND no memory ops
   - Content is just a task summary under 15 characters with no tools or files
   - Content is empty or contains only boilerplate markers
3. **Consolidate near-duplicate session-end records:** Group episodic records by tag:
   - `session-end` records: If multiple have the same or near-identical task text (e.g., all say `[Request interrupted by user for tool use]` with similar tool lists), keep only the one with the highest importance. Delete the rest.
   - `session-files` records: If multiple have the same or near-identical file list (>80% overlap), keep only the most recent. Delete the rest.
   - `session-errors` records: Same approach — deduplicate near-identical error records.

### 4. Clean procedural records

1. `memory_list(type="procedural", limit=50)` — scan through all procedural records
2. **Delete junk procedurals** that match ANY of:
   - Content is over 500 characters (real workflows are short command chains, not test scripts)
   - Commands contain `mktemp`, `sqlite3`, manual test setup, or multi-line heredocs — these are test/debug artifacts, not reusable workflows
   - Commands contain hardcoded temp paths (`/var/folders/`, `/tmp/tmp.`)
3. **Deduplicate by category:** Group procedural records by their category tag (`build`, `test`, `lint`, `install`, `deploy`). If multiple records share the same category:
   - Keep the one with the cleanest, shortest command chain
   - Delete the rest

### 5. Clean low-value patterns

1. `memory_list(type="pattern", limit=50)` — scan through all pattern records
2. **Delete low-value patterns** that match ANY of:
   - Content is just a list of tool names with no actionable insight (e.g., `**Tools:** TaskCreate, TaskUpdate, Edit, Bash`)
   - Content is just a list of file paths with no context about what was done or why
   - Title is a generic auto-generated name like `"X Y Z pattern: Tools"` and content provides no real pattern
3. **Keep patterns that:**
   - Describe a recurring behavioral theme (e.g., "Claude not using memory proactively")
   - Identify frequently co-modified files with context about why
   - Capture genuine recurring workflows or decisions

### 6. Split large multi-topic memories

For each type (`semantic`, `procedural`, `pattern`), run `memory_list` with a reasonable limit (20-50). Identify memories that are:
- Over 500 characters
- Contain multiple distinct topics (headers, bold sections, or topic shifts)

For each candidate:

1. Read it with `memory_get`
2. Identify natural topic boundaries
3. For each topic section:
   - Store as a new memory with `memory_store` using the same type, tags, context, and source
   - Title: `"{original title}: {section topic}"` (or just the section topic if no original title)
   - Content: just the section's content
4. Create `relates_to` relations between sibling sections using `memory_relate`
5. Delete the original monolithic memory with `memory_delete`

**Edge cases:**
- **Prose paragraphs**: Identify where the topic shifts even without headers. Create separate memories for each topic.
- **Mixed content**: If a memory contains both facts and procedures, split by type (store as `semantic` and `procedural` separately).
- **Lists**: If a memory is a long list, group related items together.

### 7. Report

Summarize what was done:
- Accumulative records deduplicated (before -> after count)
- Tag collisions fixed
- Episodic records consolidated (deleted count)
- Procedural records cleaned (deleted count)
- Patterns cleaned (deleted count)
- Large memories split (count processed, new memories created, relations created)
- Final memory count from `memory_health`

## Guidelines

- **Default scope is steps 2-6** (full maintenance). Use the argument to narrow scope if needed.
- **Be conservative with deletion.** If unsure whether a record is junk, keep it.
- **Preserve the best record** when deduplicating — pick the one with the most items, highest importance, or most recent date.
- **Don't split small memories** — Only process memories >500 chars with multiple topics.
- **Preserve metadata** — Keep the same type, tags, context, and source on split pieces.
- **Maintain relations** — Create `relates_to` between sibling sections.
- **Check before storing** — Use `memory_search` to avoid creating duplicates of existing memories.
- **Respect the argument filter** — If the user specified a scope (e.g., `'episodic only'`), only run that step.

$ARGUMENTS
