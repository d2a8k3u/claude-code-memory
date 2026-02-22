import { existsSync, readFileSync } from 'node:fs';

export interface TranscriptSummary {
  taskSummary: string;
  toolsUsed: string[];
  filesModified: string[];
  errorCount: number;
  memorySearches: number;
  memoryStores: number;
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);

export function parseTranscript(transcriptPath: string, cwd: string): TranscriptSummary {
  const result: TranscriptSummary = {
    taskSummary: '',
    toolsUsed: [],
    filesModified: [],
    errorCount: 0,
    memorySearches: 0,
    memoryStores: 0,
  };

  if (!transcriptPath || !existsSync(transcriptPath)) return result;

  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n');
  const toolsUsed = new Set<string>();
  const filesModified = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    // Claude Code transcripts nest the API message inside a `message` field
    const msg = (typeof raw.message === 'object' && raw.message !== null ? raw.message : raw) as Record<
      string,
      unknown
    >;

    // First user message -> task description
    if (!result.taskSummary && msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.taskSummary = msg.content.slice(0, 300);
      } else if (Array.isArray(msg.content)) {
        const textBlock = (msg.content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === 'text' && b.text,
        );
        if (textBlock?.text) {
          result.taskSummary = textBlock.text.slice(0, 300);
        }
      }
    }

    // Parse assistant tool_use blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type: string; name?: string; input?: Record<string, unknown> }>) {
        if (block.type === 'tool_use') {
          const name = block.name;
          if (name && !READ_ONLY_TOOLS.has(name)) {
            toolsUsed.add(name);
          }

          if (name === 'memory_search' || name === 'mcp__claude-memory__memory_search') {
            result.memorySearches++;
          }
          if (name === 'memory_store' || name === 'mcp__claude-memory__memory_store') {
            result.memoryStores++;
          }

          const inp = block.input ?? {};
          if ((name === 'Edit' || name === 'Write') && typeof inp.file_path === 'string') {
            filesModified.add(inp.file_path);
          }
          if (name === 'Bash' && typeof inp.command === 'string') {
            if (/\b(mv|cp|rm|mkdir|touch)\b/.test(inp.command)) {
              const pathMatch = inp.command.match(/[\w./-]+\.\w+/g);
              if (pathMatch) pathMatch.forEach((p: string) => filesModified.add(p));
            }
          }
        }
      }
    }

    // Count errors in tool results
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (/\b(error|Error|ERROR|failed|FAILED|Traceback|ENOENT|exit code [1-9])\b/.test(msg.content)) {
        result.errorCount++;
      }
    }
  }

  result.toolsUsed = [...toolsUsed];
  result.filesModified = [...filesModified].slice(0, 10).map((f) => f.replace(cwd + '/', ''));
  return result;
}
