#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"
SERVER_ENTRY="$SCRIPT_DIR/server/dist/index.js"

echo "Installing claude-memory plugin..."
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is required but not installed."
  echo "Claude Code requires Node.js, so it should already be available."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js >= 18 required (found $(node -v))"
  exit 1
fi

echo "Node.js $(node -v) detected"

# Check Claude Code
if ! command -v claude &> /dev/null; then
  echo "Error: Claude Code CLI not found."
  echo "Install it from https://claude.ai/download"
  exit 1
fi

# Install server dependencies
echo "Installing dependencies..."
cd "$SCRIPT_DIR/server"
npm install --prefer-offline 2>&1 | tail -1

# Build
echo "Building MCP server..."
npm run build 2>&1 | tail -1

# Register MCP server globally (merge into user-scoped config)
echo "Registering MCP server..."
claude mcp remove -s user claude-memory 2>/dev/null || true
if ! claude mcp add -s user claude-memory -- node "$SERVER_ENTRY"; then
  echo "Warning: 'claude mcp add' failed, writing ~/.claude/.mcp.json directly..."
  node -e "
    const fs = require('fs');
    const mcpPath = require('path').join(require('os').homedir(), '.claude', '.mcp.json');
    let config = {};
    try { config = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); } catch {}
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers['claude-memory'] = {
      command: 'node',
      args: [\"$SERVER_ENTRY\"]
    };
    fs.mkdirSync(require('path').dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
  "
fi

# Verify registration
if claude mcp list 2>/dev/null | grep -q "claude-memory"; then
  echo "  MCP server registered (user scope)"
else
  echo "  Warning: Could not verify MCP registration. You may need to run:"
  echo "    claude mcp add -s user claude-memory -- node $SERVER_ENTRY"
fi

# Install skills globally
echo "Installing skills..."
SKILLS_SRC="$SCRIPT_DIR/skills"
SKILLS_DST="$HOME/.claude/skills"
if [ -d "$SKILLS_SRC" ]; then
  # Remove stale symlinks pointing into this plugin's skills directory
  if [ -d "$SKILLS_DST" ]; then
    for existing in "$SKILLS_DST"/*/; do
      [ -L "${existing%/}" ] || continue
      link_target="$(readlink "${existing%/}")"
      case "$link_target" in
        "$SKILLS_SRC"/*)
          skill_name="$(basename "${existing%/}")"
          if [ ! -d "$SKILLS_SRC/$skill_name" ]; then
            rm -f "${existing%/}"
            echo "  Removed stale skill: $skill_name"
          fi
          ;;
      esac
    done
  fi
  # Link current skills
  mkdir -p "$SKILLS_DST"
  for skill_dir in "$SKILLS_SRC"/*/; do
    skill_name="$(basename "$skill_dir")"
    target="$SKILLS_DST/$skill_name"
    rm -rf "$target"
    ln -s "$skill_dir" "$target"
    echo "  Linked skill: $skill_name"
  done
fi

# Install slash commands globally
echo "Installing commands..."
COMMANDS_SRC="$SCRIPT_DIR/commands"
COMMANDS_DST="$HOME/.claude/commands"
if [ -d "$COMMANDS_SRC" ]; then
  # Remove stale symlinks pointing into this plugin's commands directory
  if [ -d "$COMMANDS_DST" ]; then
    for existing in "$COMMANDS_DST"/*.md; do
      [ -L "$existing" ] || continue
      link_target="$(readlink "$existing")"
      case "$link_target" in
        "$COMMANDS_SRC"/*)
          command_name="$(basename "$existing")"
          if [ ! -f "$COMMANDS_SRC/$command_name" ]; then
            rm -f "$existing"
            echo "  Removed stale command: $command_name"
          fi
          ;;
      esac
    done
  fi
  # Link current commands
  mkdir -p "$COMMANDS_DST"
  for command_file in "$COMMANDS_SRC"/*.md; do
    [ -f "$command_file" ] || continue
    command_name="$(basename "$command_file")"
    target="$COMMANDS_DST/$command_name"
    rm -f "$target"
    ln -s "$command_file" "$target"
    echo "  Linked command: ${command_name%.md}"
  done
fi

# Add hooks and permissions to global settings
echo "Configuring hooks and permissions..."
node -e "
const fs = require('fs');
const path = \"$SETTINGS_FILE\";
const pluginDir = \"$SCRIPT_DIR\";

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch {}

// Permissions
const memoryTools = [
  'mcp__claude-memory__memory_store',
  'mcp__claude-memory__memory_search',
  'mcp__claude-memory__memory_list',
  'mcp__claude-memory__memory_get',
  'mcp__claude-memory__memory_delete',
  'mcp__claude-memory__memory_update',
  'mcp__claude-memory__memory_store_batch',
  'mcp__claude-memory__memory_relate',
  'mcp__claude-memory__memory_graph',
];

if (!settings.permissions) settings.permissions = {};
if (!settings.permissions.allow) settings.permissions.allow = [];

for (const tool of memoryTools) {
  if (!settings.permissions.allow.includes(tool)) {
    settings.permissions.allow.push(tool);
  }
}

// Remove old plugin-style permission entries
settings.permissions.allow = settings.permissions.allow.filter(
  p => !p.startsWith('mcp__plugin_claude-memory')
);

// Hooks
const hooks = {
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: 'node ' + pluginDir + '/server/dist/cli.js session-start',
          statusMessage: 'Loading project memory...',
          timeout: 15,
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: 'command',
          command: 'node ' + pluginDir + '/server/dist/cli.js prompt-submit',
          timeout: 5,
        },
      ],
    },
  ],
  PreToolUse: [
    {
      hooks: [
        {
          type: 'command',
          command: 'node ' + pluginDir + '/server/dist/cli.js pre-tool-use',
          timeout: 5,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: 'node ' + pluginDir + '/server/dist/cli.js error-context',
          timeout: 5,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: 'command',
          command: 'node ' + pluginDir + '/server/dist/cli.js session-end',
          statusMessage: 'Saving session memory...',
          timeout: 15,
        },
      ],
    },
  ],
};

// Merge hooks — replace claude-memory entries, keep user's other hooks
if (!settings.hooks) settings.hooks = {};

for (const [event, newEntries] of Object.entries(hooks)) {
  const existing = settings.hooks[event] || [];
  // Remove old claude-memory hook entries
  const filtered = existing.filter(entry => {
    const cmds = (entry.hooks || []).map(h => h.command || '');
    return !cmds.some(c => c.includes('claude-memory/hooks/scripts/') || c.includes('claude-memory/server/dist/cli.js'));
  });
  settings.hooks[event] = [...filtered, ...newEntries];
}

fs.mkdirSync(require('path').dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
"

# Write CLAUDE_MEMORY.md and reference it from CLAUDE.md
echo "Configuring CLAUDE.md..."
CLAUDE_DIR="$HOME/.claude"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
MEMORY_MD="$CLAUDE_DIR/CLAUDE_MEMORY.md"
MARKER_START="<!-- claude-memory:start -->"
MARKER_END="<!-- claude-memory:end -->"
REF_LINE="@CLAUDE_MEMORY.md"

mkdir -p "$CLAUDE_DIR"

# Write the memory rules to a dedicated file (entire file is plugin-owned)
cat > "$MEMORY_MD" <<'MEMORY_EOF'
# Memory System

Your project memory is managed by the claude-memory plugin. The plugin's hooks search memory automatically on every user prompt, before risky edits, before running commands, and when it detects recall-style questions. **You do not need to call `memory_search` for routine recall** — the relevant memories arrive as context.

**When you still call the MCP tools directly:**

- `memory_store` — when the user explicitly says "remember this", when you disagree with an auto-saved memory, or when you want to save a judgement-level insight (e.g., a project convention you inferred).
- `memory_search` — when you need to look up something specific the hooks did not surface.
- `memory_relate`, `memory_update`, `memory_delete` — for curating the graph.

## Memory types

| Type         | Purpose                                                      |
| ------------ | ------------------------------------------------------------ |
| `episodic`   | What happened in sessions (auto-saved)                       |
| `pattern`    | Corrections, rules, user preferences (injected before edits) |
| `semantic`   | Project facts, architecture, conventions                     |
| `procedural` | Build/test/deploy workflows (auto-saved, injected before Bash) |
| `working`    | Session scratchpad (auto-cleared at SessionStart)            |

## What's worth storing

**The single test: store only what a future session couldn't re-derive from the code, git history, or CLAUDE.md.** This eliminates most low-value writes.

Avoid the framing "when X happens, store Y" — it produces mechanical bloat (every error logged, every command saved, every task summarized). Apply the re-derive test instead.

The judgment calls the hooks can't make for you:

- **`pattern`** — store immediately after any user correction. Most valuable signal, easy to miss. Include the rule and the reason so you can apply it to edge cases later.
- **`semantic`** — store when you *infer* a non-obvious project convention or constraint. If a future session would have to re-discover it by reading multiple files or asking the user, write it down.
- **Resolution of a problem** — don't store the fix itself if it lives in the code; `git blame` is authoritative. Store the *reasoning* that isn't recoverable from the diff (why this approach, what was rejected, what constraint forced it).

## Writing good memories

- Always write content and titles in English, even if the user communicates in another language.
- One topic per memory.
- Lead with the insight or fact, not the backstory.
- Use the specific terms someone would search for later — file paths, module names, error signatures.
- Include reasoning for decisions.
- Don't store trivial actions. Don't ask before saving — just do it silently.
MEMORY_EOF
echo "  Wrote $MEMORY_MD"

# Migration: strip any legacy inline memory section from CLAUDE.md
if [ -f "$CLAUDE_MD" ] && grep -q "$MARKER_START" "$CLAUDE_MD"; then
  TMPFILE="$(mktemp)"
  awk -v start="$MARKER_START" -v end="$MARKER_END" '
    $0 == start { skip=1; next }
    $0 == end { skip=0; next }
    !skip { print }
  ' "$CLAUDE_MD" > "$TMPFILE"
  mv "$TMPFILE" "$CLAUDE_MD"
  echo "  Removed legacy inline memory section from CLAUDE.md"
fi

# Ensure @CLAUDE_MEMORY.md reference exists in CLAUDE.md (idempotent)
if [ -f "$CLAUDE_MD" ] && grep -qxF "$REF_LINE" "$CLAUDE_MD"; then
  echo "  CLAUDE.md already references CLAUDE_MEMORY.md"
else
  if [ -f "$CLAUDE_MD" ] && [ -s "$CLAUDE_MD" ]; then
    # Ensure file ends with a newline before appending
    if [ -n "$(tail -c 1 "$CLAUDE_MD")" ]; then
      echo "" >> "$CLAUDE_MD"
    fi
    echo "" >> "$CLAUDE_MD"
  fi
  echo "$REF_LINE" >> "$CLAUDE_MD"
  echo "  Added @CLAUDE_MEMORY.md reference to CLAUDE.md"
fi

echo ""
echo "Installation complete!"
echo ""
echo "The plugin is now globally active in Claude Code."
echo "Restart Claude Code to apply changes."
echo ""
echo "First run tip: use /memory-init to bootstrap"
echo "the knowledge base from your project files."
