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

# Remove command symlinks
echo "Removing commands..."
COMMANDS_SRC="$SCRIPT_DIR/commands"
COMMANDS_DST="$HOME/.claude/commands"
if [ -d "$COMMANDS_SRC" ]; then
  for command_file in "$COMMANDS_SRC"/*.md; do
    [ -f "$command_file" ] || continue
    command_name="$(basename "$command_file")"
    target="$COMMANDS_DST/$command_name"
    if [ -L "$target" ]; then
      rm "$target"
      echo "  Removed command: ${command_name%.md}"
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

    // Remove statusline only if it is ours (leave a user's own statusline alone)
    if (settings.statusLine && typeof settings.statusLine.command === 'string'
        && settings.statusLine.command.includes('claude-memory/server/dist/cli.js statusline')) {
      delete settings.statusLine;
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

# Remove memory references from CLAUDE.md and delete CLAUDE_MEMORY.md
echo "Cleaning up CLAUDE.md..."
CLAUDE_DIR="$HOME/.claude"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
MEMORY_MD="$CLAUDE_DIR/CLAUDE_MEMORY.md"
MARKER_START="<!-- claude-memory:start -->"
MARKER_END="<!-- claude-memory:end -->"
REF_LINE="@CLAUDE_MEMORY.md"

# Strip legacy inline memory section (pre-CLAUDE_MEMORY.md installs)
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

# Remove the @CLAUDE_MEMORY.md reference line
if [ -f "$CLAUDE_MD" ] && grep -qxF "$REF_LINE" "$CLAUDE_MD"; then
  TMPFILE="$(mktemp)"
  grep -vxF "$REF_LINE" "$CLAUDE_MD" > "$TMPFILE" || true
  mv "$TMPFILE" "$CLAUDE_MD"
  echo "  Removed @CLAUDE_MEMORY.md reference from CLAUDE.md"
fi

# Delete the dedicated memory rules file
if [ -f "$MEMORY_MD" ]; then
  rm -f "$MEMORY_MD"
  echo "  Removed $MEMORY_MD"
fi

echo ""
echo "Uninstall complete!"
echo ""
echo "The plugin has been removed from Claude Code."
echo "Restart Claude Code to apply changes."
echo ""
echo "Note: The memory database (.claude/memory-db/) was NOT deleted."
echo "Remove it manually if you want to discard all stored memories."
