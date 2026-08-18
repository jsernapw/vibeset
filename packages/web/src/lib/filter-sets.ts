import type { TypeFilter } from '@vibeset/core';

export interface SavedFilterSet {
  readonly id: string;
  readonly name: string;
  readonly filter: TypeFilter;
  readonly createdAt: string;
}

const STORAGE_KEY = 'vibeset:comparison-filter-sets';

function readAll(): SavedFilterSet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedFilterSet[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(sets: SavedFilterSet[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
}

export function loadFilterSets(): SavedFilterSet[] {
  return readAll().sort((a, b) => a.name.localeCompare(b.name));
}

export function saveFilterSet(name: string, filter: TypeFilter): SavedFilterSet {
  const set: SavedFilterSet = { id: crypto.randomUUID(), name, filter, createdAt: new Date().toISOString() };
  const all = readAll().filter((s) => s.name !== name);
  all.push(set);
  writeAll(all);
  return set;
}

export function deleteFilterSet(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}
