import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CACHE_CAP = 200;

export interface SessionCache {
  session_id: string;
  injected_ids: string[];
}

function cachePath(cwd: string): string {
  return join(cwd, '.claude', 'memory-db', 'session-cache.json');
}

function statuslinePath(cwd: string): string {
  return join(cwd, '.claude', 'memory-db', '.statusline');
}

export function loadCache(cwd: string): SessionCache {
  const path = cachePath(cwd);
  if (!existsSync(path)) {
    return { session_id: '', injected_ids: [] };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as SessionCache;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.injected_ids)) {
      return { session_id: '', injected_ids: [] };
    }
    return parsed;
  } catch {
    return { session_id: '', injected_ids: [] };
  }
}

export function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function resetCache(cwd: string, sessionId: string): void {
  const path = cachePath(cwd);
  const fresh: SessionCache = { session_id: sessionId, injected_ids: [] };
  try {
    writeAtomic(path, JSON.stringify(fresh));
  } catch {
    // Non-writable cwd (synthetic test cwd, read-only fs) — cache is best-effort
  }
}

export function markInjected(cwd: string, ids: string[]): void {
  if (ids.length === 0) return;
  const path = cachePath(cwd);
  const cache = loadCache(cwd);
  const seen = new Set(cache.injected_ids);
  for (const id of ids) {
    if (!seen.has(id)) {
      cache.injected_ids.push(id);
      seen.add(id);
    }
  }
  if (cache.injected_ids.length > CACHE_CAP) {
    cache.injected_ids = cache.injected_ids.slice(cache.injected_ids.length - CACHE_CAP);
  }
  try {
    writeAtomic(path, JSON.stringify(cache));
  } catch {
    // Non-writable cwd — best-effort
  }
}

export function isInjected(cache: SessionCache, id: string): boolean {
  return cache.injected_ids.includes(id);
}

export function dedupSet(cwd: string): Set<string> {
  return new Set(loadCache(cwd).injected_ids);
}

export function deleteCache(cwd: string): void {
  const path = cachePath(cwd);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

// Precomputed badge source for the `statusline` subcommand. Stored as a tiny
// flat file (`<injected> <corpus>`) so the statusline reader never opens the DB.
// `injected` is the cumulative count loaded into context this session.
export function writeStatusline(cwd: string, injected: number, corpus: number): void {
  try {
    writeAtomic(statuslinePath(cwd), `${injected} ${corpus}`);
  } catch {
    // Non-writable cwd — badge is best-effort
  }
}

export function formatBadge(injected: number, corpus: number): string {
  if (corpus <= 0) return '🧠 0 loaded';
  return `🧠 ${injected} loaded / ${corpus}`;
}

export function readBadge(cwd: string): string {
  try {
    const raw = readFileSync(statuslinePath(cwd), 'utf-8').trim();
    const [injectedStr, corpusStr] = raw.split(/\s+/);
    const injected = Number.parseInt(injectedStr, 10);
    const corpus = Number.parseInt(corpusStr, 10);
    if (!Number.isFinite(injected) || !Number.isFinite(corpus)) return formatBadge(0, 0);
    return formatBadge(injected, corpus);
  } catch {
    return formatBadge(0, 0);
  }
}
