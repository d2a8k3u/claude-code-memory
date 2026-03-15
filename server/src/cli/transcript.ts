import { existsSync, readFileSync } from 'node:fs';

export type BashCategory = 'build' | 'test' | 'lint' | 'format' | 'install' | 'deploy' | 'git' | 'other';

export interface BashCommand {
  command: string;
  success: boolean;
  category: BashCategory;
}

export interface TranscriptSummary {
  taskSummary: string;
  toolsUsed: string[];
  toolCallCount: number;
  filesModified: string[];
  filesRead: string[];
  errorCount: number;
  memorySearches: number;
  memoryStores: number;
  bashCommands: BashCommand[];
  technologies: string[];
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
const NOISE_TOOL_PREFIXES = ['mcp__claude-memory__'];

function isNoiseTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name) || NOISE_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

const CATEGORY_PATTERNS: [BashCategory, RegExp][] = [
  ['test', /\b(jest|vitest|mocha|pytest|cargo\s+test|go\s+test|npm\s+test|npx\s+test|node\s+--test)\b/],
  ['lint', /\b(eslint|pylint|flake8|clippy|golangci-lint|tsc\s+--noEmit|biome\s+check|oxlint)\b/],
  ['format', /\b(prettier|black|rustfmt|gofmt|biome\s+format)\b/],
  ['build', /\b(npm\s+run\s+build|tsc|webpack|vite\s+build|rollup|esbuild|cargo\s+build|go\s+build|make)\b/],
  [
    'install',
    /\b(npm\s+install|npm\s+i\b|yarn\s+(add|install)|pnpm\s+(add|install)|pip\s+install|cargo\s+add|go\s+get)\b/,
  ],
  ['deploy', /\b(docker|kubectl|helm|terraform|ansible|deploy|pm2|systemctl)\b/],
  ['git', /\b(git\s+(commit|push|pull|merge|rebase|cherry-pick|stash|tag))\b/],
];

const TECH_FROM_COMMANDS: [string, RegExp][] = [
  ['node', /\bnode\b/],
  ['npm', /\bnpm\b/],
  ['typescript', /\btsc\b/],
  ['python', /\b(python3?|pip|pytest)\b/],
  ['rust', /\b(cargo|rustc)\b/],
  ['go', /\bgo\s+(build|test|run|get)\b/],
  ['docker', /\bdocker\b/],
  ['postgres', /\bpsql\b/],
];

const TECH_FROM_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

function categorizeCommand(command: string): BashCategory {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(command)) return category;
  }
  return 'other';
}

function detectTechFromCommand(command: string): string[] {
  const techs: string[] = [];
  for (const [tech, pattern] of TECH_FROM_COMMANDS) {
    if (pattern.test(command)) techs.push(tech);
  }
  return techs;
}

function detectTechFromFile(filePath: string): string | null {
  const ext = filePath.match(/\.[^.]+$/)?.[0];
  return ext ? (TECH_FROM_EXTENSIONS[ext] ?? null) : null;
}

export function parseTranscript(transcriptPath: string, cwd: string): TranscriptSummary {
  const result: TranscriptSummary = {
    taskSummary: '',
    toolsUsed: [],
    toolCallCount: 0,
    filesModified: [],
    filesRead: [],
    errorCount: 0,
    memorySearches: 0,
    memoryStores: 0,
    bashCommands: [],
    technologies: [],
  };

  if (!transcriptPath || !existsSync(transcriptPath)) return result;

  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n');
  const toolsUsed = new Set<string>();
  const filesModified = new Set<string>();
  const filesRead = new Set<string>();
  const technologies = new Set<string>();
  const pendingBash = new Map<string, string>();

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
        result.taskSummary = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textBlock = (msg.content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === 'text' && b.text,
        );
        if (textBlock?.text) {
          result.taskSummary = textBlock.text;
        }
      }
    }

    // Parse assistant tool_use blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>) {
        if (block.type === 'tool_use') {
          const name = block.name;
          if (name && !isNoiseTool(name)) {
            toolsUsed.add(name);
            result.toolCallCount++;
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
            const tech = detectTechFromFile(inp.file_path);
            if (tech) technologies.add(tech);
          }
          if (name === 'Read' && typeof inp.file_path === 'string') {
            filesRead.add(inp.file_path);
            const tech = detectTechFromFile(inp.file_path);
            if (tech) technologies.add(tech);
          }
          if (name === 'Bash' && typeof inp.command === 'string') {
            const cmd = inp.command;
            if (/\b(mv|cp|rm|mkdir|touch)\b/.test(cmd)) {
              const pathMatch = cmd.match(/[\w./-]+\.\w+/g);
              if (pathMatch) pathMatch.forEach((p: string) => filesModified.add(p));
            }

            if (block.id) {
              pendingBash.set(block.id, cmd);
            }

            for (const tech of detectTechFromCommand(cmd)) {
              technologies.add(tech);
            }
          }
        }
      }
    }

    if (msg.role === 'tool') {
      const toolUseId = msg.tool_use_id as string | undefined;
      const content = typeof msg.content === 'string' ? msg.content : '';

      if (toolUseId && pendingBash.has(toolUseId)) {
        const cmd = pendingBash.get(toolUseId);
        if (!cmd) continue;
        pendingBash.delete(toolUseId);
        const isError = /\b(error|Error|ERROR|failed|FAILED|Traceback|ENOENT|exit code [1-9])\b/.test(content);
        result.bashCommands.push({
          command: cmd,
          success: !isError,
          category: categorizeCommand(cmd),
        });
        if (isError) result.errorCount++;
      } else {
        // Uncorrelated tool result (still count errors)
        if (/\b(error|Error|ERROR|failed|FAILED|Traceback|ENOENT|exit code [1-9])\b/.test(content)) {
          result.errorCount++;
        }
      }
    }
  }

  for (const [, cmd] of pendingBash) {
    result.bashCommands.push({
      command: cmd,
      success: true,
      category: categorizeCommand(cmd),
    });
  }

  result.toolsUsed = [...toolsUsed];
  result.filesModified = [...filesModified].map((f) => f.replace(cwd + '/', ''));
  result.filesRead = [...filesRead].map((f) => f.replace(cwd + '/', ''));
  result.technologies = [...technologies];
  return result;
}
