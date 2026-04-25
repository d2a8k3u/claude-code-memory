import type { MemoryDatabase } from '../database.js';

export async function rewriteLegacyTitles(db: MemoryDatabase): Promise<{ rewritten: number }> {
  const eps = db.listMemories('episodic', 10000, 0);
  let rewritten = 0;
  for (const m of eps) {
    if (!/^\s*\*\*(Task|Files|Tools|Errors|Memory ops):\*\*/.test(m.content)) continue;

    const taskMatch = m.content.match(/\*\*Task:\*\*\s*(.+?)(?:\n|$)/);
    const task = taskMatch?.[1]?.trim() ?? '';
    const filesMatch = m.content.match(/\*\*Files modified:\*\*\s*(.+?)(?:\n|$)/);
    const files = filesMatch?.[1]?.trim() ?? '';
    const toolsMatch = m.content.match(/\*\*Tools:\*\*\s*(.+?)(?:\n|$)/);
    const tools = toolsMatch?.[1]?.trim() ?? '';

    const title =
      task.length >= 10 ? (task.length <= 80 ? task : task.slice(0, 77) + '…') : (m.title ?? 'Session activity');
    const parts: string[] = [];
    if (task) parts.push(task);
    const facts: string[] = [];
    if (tools) facts.push(`used tools: ${tools}`);
    if (files) facts.push(`touched files: ${files}`);
    if (facts.length > 0) parts.push(facts.join('; '));
    const content = parts.join(' ');

    db.updateMemory(m.id, { title, content });
    rewritten++;
  }
  return { rewritten };
}

export async function handleCleanup(db: MemoryDatabase, args: string[]): Promise<void> {
  if (args.includes('--rewrite-titles')) {
    const { rewritten } = await rewriteLegacyTitles(db);
    process.stdout.write(`Rewrote ${rewritten} legacy episodic titles.\n`);
  } else {
    process.stderr.write('Usage: cli cleanup --rewrite-titles\n');
  }
}
