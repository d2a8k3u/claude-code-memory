#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "Uninstalling claude-memory plugin..."
echo ""

# Remove MCP server registration
echo "Removing MCP server..."
if command -v claude &> /dev/null; then
  claude mcp remove -s user claude-memory 2>/dev/null || true
fi

# Clean .mcp.json fallback if it exists
MCP_JSON="$HOME/.claude/.mcp.json"
if [ -f "$MCP_JSON" ]; then
  node -e "
    const fs = require('fs');
    const path = \"$MCP_JSON\";
    try {
      const config = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (config.mcpServers && config.mcpServers['claude-memory']) {
        delete config.mcpServers['claude-memory'];
        fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
        console.log('  Removed from .mcp.json');
      }
    } catch {}
  "
fi

# Remove skills symlinks
echo "Removing skills..."
SKILLS_SRC="$SCRIPT_DIR/skills"
SKILLS_DST="$HOME/.claude/skills"
if [ -d "$SKILLS_SRC" ]; then
  for skill_dir in "$SKILLS_SRC"/*/; do
    skill_name="$(basename "$skill_dir")"
    target="$SKILLS_DST/$skill_name"
    if [ -L "$target" ]; then
      rm "$target"
      echo "  Removed skill: $skill_name"
    fi
  done
fi

# Remove hooks and permissions from global settings
echo "Removing hooks and permissions..."
if [ -f "$SETTINGS_FILE" ]; then
  node -e "
    const fs = require('fs');
    const path = \"$SETTINGS_FILE\";

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch { process.exit(0); }

    // Remove permissions
    if (settings.permissions && settings.permissions.allow) {
      settings.permissions.allow = settings.permissions.allow.filter(
        p => !p.startsWith('mcp__claude-memory__')
      );
    }

    // Remove hooks
    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        settings.hooks[event] = (settings.hooks[event] || []).filter(entry => {
          const cmds = (entry.hooks || []).map(h => h.command || '');
          return !cmds.some(c => c.includes('claude-memory/server/dist/cli.js'));
        });
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  "
fi

echo ""
echo "Uninstall complete!"
echo ""
echo "The plugin has been removed from Claude Code."
echo "Restart Claude Code to apply changes."
echo ""
echo "Note: The memory database (.claude/memory-db/) was NOT deleted."
echo "Remove it manually if you want to discard all stored memories."
