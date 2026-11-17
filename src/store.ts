// All data stays on the device (localStorage).
import type { SetRecord } from './tracker';

const KEY = 'fla.sets.v1';
const PREFS = 'fla.prefs.v1';

export function loadSets(): SetRecord[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SetRecord[]; } catch { return []; }
}
function save(sets: SetRecord[]) { localStorage.setItem(KEY, JSON.stringify(sets)); }
export function addSet(s: SetRecord) { const all = loadSets(); all.push(s); save(all); }
export function deleteSet(id: string) { save(loadSets().filter(s => s.id !== id)); }

export function exportJson(): string { return JSON.stringify({ app: 'front-lever-analyst', version: 1, sets: loadSets() }); }
/** Merges by id. Returns how many sets were added. */
export function importJson(text: string): number {
  const data = JSON.parse(text) as { sets?: SetRecord[] };
  if (!Array.isArray(data.sets)) throw new Error('bad file');
  const all = loadSets(), ids = new Set(all.map(s => s.id));
  const fresh = data.sets.filter(s => s && typeof s.id === 'string' && Array.isArray(s.samples) && !ids.has(s.id));
  save([...all, ...fresh].sort((a, b) => a.at - b.at));
  return fresh.length;
}

export interface Prefs {
  mode: 'hold' | 'negative'; variation: string; sound: boolean; facing: 'environment' | 'user';
  /** Hold target in seconds (0 = none): beeps when reached. */
  target: number;
}
export function loadPrefs(): Prefs {
  const d: Prefs = { mode: 'hold', variation: 'auto', sound: true, facing: 'environment', target: 0 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }; } catch { return d; }
}
export function savePrefs(p: Prefs) { localStorage.setItem(PREFS, JSON.stringify(p)); }
