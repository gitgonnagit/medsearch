'use client';

import MiniSearch from 'minisearch';
import type { SearchCompanionRow } from '@pipeline/types';

/** Public shape of a search result row. */
export interface SearchHit {
  id: string;
  score: number;
  brandName: string | null;
  genericName: string;
  dosageForm: string | null;
  manufacturer: string | null;
  isLimitedUse: boolean;
  inLcaCategory: boolean;
  inRdpCategory: boolean;
}

interface SearchState {
  index: MiniSearch<SearchInputDoc>;
  companionById: Map<string, SearchCompanionRow>;
  ready: boolean;
}

interface SearchInputDoc {
  id: string;
  brandName: string;
  genericName: string;
  dosageForm: string;
  manufacturer: string;
}

let STATE: SearchState | null = null;
let LOAD_PROMISE: Promise<SearchState> | null = null;

// Module-level base path that works regardless of whether Next's
// `NEXT_PUBLIC_*` inlining pass picked up our env var. Reads the env var
// first (so the build-time value wins if Next did inline it), then
// auto-detects from `window.location.pathname` (the first path segment
// after the host) so the same client bundle works for project sites
// like `${owner}.github.io/${repo}/` even when CI never set the env.
// Falls back to '' for owner-page hosting (`<owner>.github.io`).
const BASE_PATH: string = (() => {
  if (typeof window !== 'undefined') {
    const seg = window.location.pathname.split('/').filter(Boolean)[0];
    if (seg) return '/' + seg;
  }
  return process.env.NEXT_PUBLIC_BASE_PATH ?? '';
})();

/**
 * Lazy-load the search index + companion data on first call. Returns the
 * already-loaded state on subsequent calls.
 *
 * We deliberately *don't* import MiniSearch eagerly so it doesn't get pulled
 * into the SSR bundle; the loader runs only in the browser.
 */
export function ensureSearchLoaded(): Promise<SearchState> {
  if (STATE && STATE.ready) return Promise.resolve(STATE);
  if (LOAD_PROMISE) return LOAD_PROMISE;
  LOAD_PROMISE = (async () => {
    // BASE_PATH is computed at module-load (see top of file). We don't
    // re-compute it on every search call.
    const base = BASE_PATH;
    const [indexJson, companion]: [string, SearchCompanionRow[]] = await Promise.all([
      fetch(`${base}/data/search-index.json`).then((r) => {
        if (!r.ok) throw new Error(`search-index.json: ${r.status}`);
        return r.text();
      }),
      fetch(`${base}/data/related.json`).then((r) => {
        if (!r.ok) throw new Error(`related.json: ${r.status}`);
        return r.json() as Promise<SearchCompanionRow[]>;
      }),
    ]);

    // MiniSearch 7.x: loadJSON() takes an `AsPlainObject` (the parsed JSON
    // object). loadJS() does the same; we parse once then loadIt from object.
    const mini = MiniSearch.loadJSON<SearchInputDoc>(
      JSON.parse(indexJson),
      {
        idField: 'id',
        fields: ['brandName', 'genericName', 'manufacturer', 'dosageForm', 'id'],
        storeFields: ['id', 'brandName', 'genericName', 'dosageForm', 'manufacturer'],
        searchOptions: {
          prefix: true,
          fuzzy: 0.2,
          boost: { brandName: 2, genericName: 1, dosageForm: 1.5, manufacturer: 0.5, id: 1.0 },
          combineWith: 'AND',
        },
      },
    );

    const companionById = new Map<string, SearchCompanionRow>();
    for (const row of companion) companionById.set(row.id, row);

    STATE = { index: mini, companionById, ready: true };
    return STATE;
  })();
  return LOAD_PROMISE;
}

/** Run a search and return ranked results. */
export async function search(query: string, opts?: { limit?: number; dosageForm?: string | null }): Promise<SearchHit[]> {
  const state = await ensureSearchLoaded();
  const limit = opts?.limit ?? 100;
  const dosageForm = opts?.dosageForm?.trim() ?? '';
  const trimmed = query.trim();
  if (!trimmed) return [];
  const results = state.index.search(trimmed);
  let hits: SearchHit[] = results.map((r) => {
    const c = state.companionById.get(String(r.id));
    return {
      id: String(r.id),
      score: r.score,
      brandName: (r['brandName'] as string | null) ?? null,
      genericName: String(r['genericName'] ?? ''),
      dosageForm: (r['dosageForm'] as string | null) ?? null,
      manufacturer: (r['manufacturer'] as string | null) ?? null,
      isLimitedUse: c?.isLimitedUse ?? false,
      inLcaCategory: c?.inLcaCategory ?? false,
      inRdpCategory: c?.inRdpCategory ?? false,
    };
  });
  if (dosageForm) {
    hits = hits.filter((h) => (h.dosageForm ?? '').toLowerCase() === dosageForm.toLowerCase());
  }
  return hits.slice(0, limit);
}

/** Distinct, normalized dosage forms present in the dataset (lazy). */
export async function listDosageForms(): Promise<string[]> {
  const state = await ensureSearchLoaded();
  const set = new Set<string>();
  for (const row of state.companionById.values()) {
    const f = (row.dosageForm ?? '').trim();
    if (f) set.add(f);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Debounce a function in the browser. */
export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
