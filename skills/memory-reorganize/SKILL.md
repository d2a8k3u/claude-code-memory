---
name: memory-reorganize
description: >
  Reorganize project memory by splitting large multi-topic memories into
  focused, topic-specific units. Handles cases the structural splitter
  can't — prose without headers, semantic topic boundaries, and manual
  curation.
argument-hint: "[optional: type filter like 'semantic only' or 'patterns']"
---

# Memory Reorganization

Analyze and reorganize the project memory. Split large monolithic memories into smaller, focused units so that search returns only the relevant topic instead of entire documents.

## Steps

### 1. Assess Current State

Run `memory_health` to get an overview of memory counts, types, and staleness.

### 2. Identify Candidates

For each type (`semantic`, `procedural`, `pattern`), run `memory_list` with a reasonable limit (20-50). Identify memories that are:
- Over 500 characters
- Contain multiple distinct topics (look for headers, bold sections, or topic shifts)
- Would benefit from being split into focused units

### 3. Process Each Candidate

For each large multi-topic memory:

1. Read it with `memory_get`
2. Identify the natural topic boundaries
3. For each topic section:
   - Store as a new memory with `memory_store` using:
     - Same type as original
     - Title: `"{original title}: {section topic}"` (or just the section topic if no original title)
     - Same tags, context, source as original
     - Content: just the section's content
4. Create `relates_to` relations between sibling sections using `memory_relate`
5. Delete the original monolithic memory with `memory_delete`

### 4. Handle Edge Cases

Some memories can't be split by headers alone:
- **Prose paragraphs**: Read the content and identify where the topic shifts. Create separate memories for each topic.
- **Mixed content**: If a memory contains both facts and procedures, split by type (store as `semantic` and `procedural` separately).
- **Lists**: If a memory is a long list, group related items together.

### 5. Report Results

Summarize what was done:
- Number of memories processed
- Number split into multiple memories
- Number of new memories created
- Number of relations created
- Number of originals deleted

## Guidelines

1. **Don't split small memories** — Only process memories >500 chars with multiple topics.
2. **Preserve metadata** — Keep the same type, tags, context, and source on split pieces.
3. **Maintain relations** — Create `relates_to` between sibling sections.
4. **Check before storing** — Use `memory_search` to avoid creating duplicates of existing memories.
5. **Be conservative** — If unsure whether to split, leave it as-is.
6. **Respect the type filter** — If the user specified a type, only process that type.

$ARGUMENTS
