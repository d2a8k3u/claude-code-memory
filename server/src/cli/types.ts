export type HookInput = {
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_output?: string;
}

export type HookOutput = {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
  ok?: boolean;
}

export function writeHookOutput(output: HookOutput): void {
  process.stdout.write(JSON.stringify(output));
}

export async function readStdin(): Promise<HookInput> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return JSON.parse(input) as HookInput;
}
