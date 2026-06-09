import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryDatabase } from '../database.js';

export type ProjectIdentity = { name: string; version: string };

// Checked in order; first file with both a string name and version wins.
const VERSION_FILES = ['.claude-plugin/plugin.json', 'package.json', 'plugin.json'];

export function readProjectIdentity(cwd: string): ProjectIdentity | null {
  for (const rel of VERSION_FILES) {
    try {
      const json = JSON.parse(readFileSync(join(cwd, rel), 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof json.version === 'string' && typeof json.name === 'string') {
        return { name: json.name, version: json.version };
      }
    } catch {
      // missing or unparseable — try the next candidate
    }
  }
  return null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Parses a semver-ish token into [major, minor, patch]; null if not a version. */
function parseVersion(token: string): [number, number, number] | null {
  const m = token.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : 0];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const VERSION_TOKEN_RE = /\bv?\d+\.\d+(?:\.\d+)?\b/g;

/**
 * A memory's TITLE is stale relative to the project when it (a) names this project
 * and (b) carries a version token older than the current project version, with NO
 * token at or above the current version. Title-only on purpose: titles are curated,
 * so a version there is the memory's subject version — not an incidental dependency
 * version buried in content (e.g. "transformers@3.8.1"). This keeps the pass from
 * ever demoting a still-valid memory.
 */
export function isTitleVersionStale(title: string | null, project: ProjectIdentity): boolean {
  if (!title) return false;
  const current = parseVersion(project.version);
  if (!current) return false;

  const normProject = normalize(project.name);
  if (normProject.length < 3 || !normalize(title).includes(normProject)) return false;

  const versions = [...title.matchAll(VERSION_TOKEN_RE)]
    .map((m) => parseVersion(m[0]))
    .filter((v): v is [number, number, number] => v !== null);
  if (versions.length === 0) return false;

  // If the title mentions the current version (or newer), treat it as current.
  if (versions.some((v) => compareVersion(v, current) >= 0)) return false;
  return versions.some((v) => compareVersion(v, current) < 0);
}

/** Highest version token found in `text`, or null if it contains none. */
export function extractMaxVersion(text: string): [number, number, number] | null {
  const versions = [...text.matchAll(VERSION_TOKEN_RE)]
    .map((m) => parseVersion(m[0]))
    .filter((v): v is [number, number, number] => v !== null);
  if (versions.length === 0) return null;
  return versions.reduce((max, v) => (compareVersion(v, max) > 0 ? v : max));
}

/**
 * True if `newerTitle` carries a strictly-higher version token than `olderTitle`.
 * Title-only (not content) so incidental dependency versions in the body never
 * trigger a spurious supersession.
 */
export function supersedesByVersion(newerTitle: string, olderTitle: string): boolean {
  const a = extractMaxVersion(newerTitle);
  const b = extractMaxVersion(olderTitle);
  if (!a || !b) return false;
  return compareVersion(a, b) > 0;
}

/**
 * Demotes semantic/pattern memories whose title describes an OLDER version of the
 * current project (e.g. a "Feature Inventory (v0.2.0)" while the project is 1.2.0).
 * They keep getting injected on text relevance otherwise — semantic memories never
 * age out — so we mark them superseded. Returns the number demoted.
 */
export function suppressStaleProjectMemories(db: MemoryDatabase, cwd: string): number {
  const project = readProjectIdentity(cwd);
  if (!project) return 0;
  let count = 0;
  for (const c of db.getActiveByTypeForStaleness()) {
    if (isTitleVersionStale(c.title, project)) {
      db.markSuperseded(c.id, `project:${project.version}`);
      count++;
    }
  }
  return count;
}
