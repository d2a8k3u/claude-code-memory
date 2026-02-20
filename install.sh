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

# Register MCP server globally
echo "Registering MCP server..."
claude mcp add --scope user claude-memory node "$SERVER_ENTRY" 2>/dev/null || true

# Add hooks and permissions to global settings
echo "Configuring hooks and permissions..."
node -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';
const pluginDir = '$SCRIPT_DIR';

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
          command: 'node ' + pluginDir + '/hooks/scripts/session-start.js',
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
          command: 'node ' + pluginDir + '/hooks/scripts/post-tool-use.js',
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
          command: 'node ' + pluginDir + '/hooks/scripts/session-end.js',
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
    return !cmds.some(c => c.includes('claude-memory/hooks/scripts/'));
  });
  settings.hooks[event] = [...filtered, ...newEntries];
}

fs.mkdirSync(require('path').dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
"

echo ""
echo "Installation complete!"
echo ""
echo "The plugin is now globally active in Claude Code."
echo "Restart Claude Code to apply changes."
echo ""
echo "First run tip: use /claude-memory:memory-init to bootstrap"
echo "the knowledge base from your project files."
