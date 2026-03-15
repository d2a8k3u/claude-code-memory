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

# Add memory instructions to CLAUDE.md
echo "Configuring CLAUDE.md..."
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
MARKER_START="<!-- claude-memory:start -->"
MARKER_END="<!-- claude-memory:end -->"

MEMORY_SECTION="$MARKER_START
## Memory System

You have project memory via MCP tools (\`memory_store\`, \`memory_search\`, etc.). Use them proactively and automatically — never ask the user before saving or searching.

**Memory is the source of truth for task history, lessons, and project conventions.**

**CRITICAL: The SessionStart hook injects a broad overview of memories based on git signals. This passive context is NOT a substitute for active \`memory_search\` calls. You MUST still search actively throughout the session.**

**Memory search is MANDATORY before any task, no exceptions.**
Passive SessionStart context does NOT count as active search.
If memory tools are unavailable, say so explicitly before starting.

### When to search (\`memory_search\`)

- **ALWAYS at the start of any non-trivial task**: search for prior work on the module/feature you are about to touch. Do this BEFORE writing any code.
- **During work**: whenever you encounter a topic, convention, or decision the user might have discussed before — search memory instead of asking or guessing. The user should never have to say \"check your memory\".
- Before making architectural decisions: search for prior decisions (type \`pattern\`)
- When encountering errors: search with error message keywords
- When touching unfamiliar code: search for notes about that module/file

### Memory types and what goes where

| Type         | Purpose                                                   |
| ------------ | --------------------------------------------------------- |
| \`episodic\`   | What happened this session (task, files, errors, outcome) |
| \`pattern\`    | Lessons learned, recurring mistakes, correction rules     |
| \`semantic\`   | Project facts, tech stack, conventions                    |
| \`procedural\` | Build/test/deploy workflows                               |
| \`working\`    | Session scratchpad — auto-cleared next session            |

### When to save manually (\`memory_store\`)

Auto-save covers routine facts. Use \`memory_store\` manually for insights automation might miss:

- After ANY correction from the user → store \`pattern\` memory immediately
- Important architectural decisions or design rationale
- Non-obvious bug fixes worth remembering
- User preferences or project-specific conventions
- Corrections to auto-created memories

### Rules

- **Always write memory content and titles in English**, even if the user communicates in another language. Translate if needed. This ensures consistent search and retrieval across sessions.
- Search before storing to avoid duplicates
- Be concise: 1-3 sentences per memory
- Use lowercase hyphenated tags
- Don't store trivial actions (simple reads, ls commands)
- Don't ask the user before saving — just do it silently
$MARKER_END"

mkdir -p "$(dirname "$CLAUDE_MD")"

if [ -f "$CLAUDE_MD" ] && grep -q "$MARKER_START" "$CLAUDE_MD"; then
  # Replace existing section: remove old markers+content, write new
  TMPFILE="$(mktemp)"
  awk -v start="$MARKER_START" -v end="$MARKER_END" '
    $0 == start { skip=1; next }
    $0 == end { skip=0; next }
    !skip { print }
  ' "$CLAUDE_MD" > "$TMPFILE"
  mv "$TMPFILE" "$CLAUDE_MD"
  echo "$MEMORY_SECTION" >> "$CLAUDE_MD"
  echo "  Updated existing memory section in CLAUDE.md"
else
  # Append to file (create if needed)
  if [ -f "$CLAUDE_MD" ]; then
    echo "" >> "$CLAUDE_MD"
  fi
  echo "$MEMORY_SECTION" >> "$CLAUDE_MD"
  echo "  Added memory section to CLAUDE.md"
fi

echo ""
echo "Installation complete!"
echo ""
echo "The plugin is now globally active in Claude Code."
echo "Restart Claude Code to apply changes."
echo ""
echo "First run tip: use /memory-init to bootstrap"
echo "the knowledge base from your project files."
