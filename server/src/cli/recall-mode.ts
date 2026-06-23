import type { MemoryDatabase } from '../database.js';

export type RecallMode = 'normal' | 'off';

const META_KEY = 'recall_mode';

/** Per-project recall kill-switch. 'off' silences every recall hook; storing stays active. */
export function getRecallMode(db: MemoryDatabase): RecallMode {
  return db.getSessionMeta(META_KEY) === 'off' ? 'off' : 'normal';
}

export function setRecallMode(db: MemoryDatabase, mode: RecallMode): void {
  db.setSessionMeta(META_KEY, mode);
}
