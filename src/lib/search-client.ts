'use client';

import MiniSearch from 'minisearch';
import type { SearchCompanionRow } from '@pipeline/types';

/** Public shape of a search result row. */
export interface SearchHit {
  id: string;
  score: number;
  brandName: string | null;
  genericName: string;
  /** Raw `dosageForm` from PDDF — kept verbatim on the result row. */
  dosageForm: string | null;
  /** Bucket category (one of the 8 canonical chips). */
  canonicalDosageForm: string | null;
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

// Cached promise so the canonical-dosage-forms.json fetch happens once
// per page load even if `listCanonicalDosageForms()` is called many times.
let CANONICAL_LIST_PROMISE: Promise<string[]> | null = null;

// Project-site base path = '/medsearch'. We deliberately encode the
// string as base64 and decode at runtime rather than declaring a
// literal `'/medsearch'` constant: Next.js's static-export SWC
// compiler is configured with `basePath: '/medsearch'` and recognises
// that exact string inside absolute-path literals, stripping it from
// emitted JS to avoid double-prefixing at runtime. The flip side is
// that fetch URLs like `/medsearch/data/search-index.json` lose the
// `/medsearch/` prefix and end up emitted as bare `/data/...` and 404
// against the project-site subpath. Decoding base64 (`atob`) can't be
// folded by SWC because it's an opaque function call, so the literal
// `/medsearch` never appears bare.
//
// Base64 of "/medsearch" = "L21lZHNlYXJjaA==" (verified with:
//   node -e 'console.log(Buffer.from("/medsearch").toString("base64"))')
//
// `'use client'` modules run twice in the Next.js build: once during
// SSR pre-render on Node (where `atob` is global in Node ≥ 16 — safe
// for our GH Actions workflow which pins Node 22), and once in the
// browser on hydration. In both environments `atob('L21lZHNlYXJjaA==')`
// returns `'/medsearch'`.
const BASE_PATH = atob('L21lZHNlYXJjaA==');

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
    // BASE_PATH is module-scope (always '/medsearch' for this site).
    const [indexJson, companion]: [string, SearchCompanionRow[]] = await Promise.all([
      fetch(`${BASE_PATH}/data/search-index.json`).then((r) => {
        if (!r.ok) throw new Error(`search-index.json: ${r.status}`);
        return r.text();
      }),
      fetch(`${BASE_PATH}/data/related.json`).then((r) => {
        if (!r.ok) throw new Error(`related.json: ${r.status}`);
        return r.json() as Promise<SearchCompanionRow[]>;
      }),
    ]);

    // MiniSearch 7.x: `loadJSON()` accepts the *stringified* JSON of a
    // previously-saved index (i.e. the buffer we just fetched). It calls
    // `JSON.parse()` internally. Passing a parsed object would cause V8 to
    // coerce it to the literal string `'[object Object]'` first, which
    // `JSON.parse` then rejects with `"[object Object]" is not valid JSON`.
    // That is exactly the user-facing error banner we were chasing through
    // the basePath investigations — the upstream fetches were always fine.
    // (Use `loadJS()` instead if you have a parsed object on hand.)
    const mini = MiniSearch.loadJSON<SearchInputDoc>(indexJson, {
      idField: 'id',
      fields: ['brandName', 'genericName', 'manufacturer', 'dosageForm', 'id'],
      storeFields: ['id', 'brandName', 'genericName', 'dosageForm', 'manufacturer'],
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: { brandName: 2, genericName: 1, dosageForm: 1.5, manufacturer: 0.5, id: 1.0 },
        combineWith: 'AND',
      },
    });

    const companionById = new Map<string, SearchCompanionRow>();
    for (const row of companion) companionById.set(row.id, row);

    STATE = { index: mini, companionById, ready: true };
    return STATE;
  })();
  return LOAD_PROMISE;
}

/** Run a search and return ranked results. */
export async function search(query: string, opts?: { limit?: number; canonicalDosageForm?: string | null }): Promise<SearchHit[]> {
  const state = await ensureSearchLoaded();
  const limit = opts?.limit ?? 100;
  // `canonicalDosageForm` is one of the 8 canonical chip names (e.g. "oral
  // solid", "topical"). We filter by canonical category, not the raw
  // PDDF value, so the chip strip is intentionally limited to those 8.
  const canonicalFilter = (opts?.canonicalDosageForm ?? '').trim();
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
      canonicalDosageForm: (r['canonicalDosageForm'] as string | null) ?? null,
      manufacturer: (r['manufacturer'] as string | null) ?? null,
      isLimitedUse: c?.isLimitedUse ?? false,
      inLcaCategory: c?.inLcaCategory ?? false,
      inRdpCategory: c?.inRdpCategory ?? false,
    };
  });
  if (canonicalFilter) {
    hits = hits.filter((h) => (h.canonicalDosageForm ?? '') === canonicalFilter);
  }
  return hits.slice(0, limit);
}

/**
 * Distinct, canonical dosage-form categories for the home-page chip
 * strip. Reads `canonical-dosage-forms.json` (written by the pipeline
 * at build time) so the frontend and the pipeline share one source of
 * truth — never go out of sync.
 */
export async function listCanonicalDosageForms(): Promise<string[]> {
  if (CANONICAL_LIST_PROMISE) return CANONICAL_LIST_PROMISE;
  CANONICAL_LIST_PROMISE = (async () => {
    const r = await fetch(`${BASE_PATH}/data/canonical-dosage-forms.json`);
    if (!r.ok) throw new Error(`canonical-dosage-forms.json: ${r.status}`);
    return (await r.json()) as string[];
  })();
  return CANONICAL_LIST_PROMISE;
}

/** Debounce a function in the browser. */
export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
