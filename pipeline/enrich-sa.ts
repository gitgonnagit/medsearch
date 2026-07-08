/**
 * Special Authority enrichment.
 *
 * The BC PharmaCare SA drug list is published as an HTML table on a
 * government page; each row contains a generic name with a link to the SA
 * criteria/form. We:
 *   1. Scrape the page (already fetched by sources.fetchSaListHtml).
 *   2. Normalize generic names (lowercase, strip punctuation, brand symbols).
 *   3. Match by exact normalized equality; on miss, fall back to Fuse.js fuzzy
 *      matching with a conservative threshold (≥ 0.85).
 *   4. Return a Map<DIN, saLink> best-effort. Unmatched drugs keep their
 *      fallback directory link only.
 */

import Fuse from 'fuse.js';
import type { Drug } from './types.js';
import { normalizeForMatching } from './helpers.js';

export interface SaRow {
  genericName: string;
  brandNames: string[];
  saLink: string | null;
}

export interface SaEnrichmentResult {
  /** Map from drug-id to the matched SA criteria link. */
  matchedLinks: Map<string, string>;
  /** List of drugs in our dataset whose SA flag is Y but couldn't be matched directly. */
  unmatchedLimitedUseIds: string[];
  /** Whether at least one drug failed matching (for build warnings). */
  hadMisses: boolean;
}

/** Produce a SA→DIN map using exact + fuzzy matching. */
export function matchSpecialAuthority(
  drugs: Drug[],
  saRows: SaRow[],
): SaEnrichmentResult {
  const matchedLinks = new Map<string, string>();
  const unmatchedLimitedUseIds: string[] = [];

  // Build the search index from SA rows. We use a custom key function so all
  // brand name variants in a single SA row can be looked up by the same
  // matching attempt.
  const saKeyIndex = saRows.flatMap((row, idx) => {
    const keys = [row.genericName, ...row.brandNames];
    return keys
      .filter((k) => k && k.length >= 3 && !/^[a-z]$/i.test(k))
      .map((k) => ({
        idx,
        key: k,
        normalized: normalizeForMatching(k),
      }));
  });

  // Drug-side: build a list of (id, genericName, brandName) we want to match.
  const drugKeyEntries = drugs
    .filter((d) => d.isLimitedUse)
    .flatMap((d) => {
      const candidates = [d.genericName, d.brandName].filter(Boolean) as string[];
      return candidates.map((key) => ({ id: d.id, key, normalized: normalizeForMatching(key) }));
    });

  const fuseKey = saKeyIndex.map((entry) => ({ ...entry, _id: `${entry.idx}:${entry.key}` }));
  const fuse = new Fuse(fuseKey, {
    keys: ['normalized'],
    includeScore: true,
    threshold: 0.4, // score 0.0 = perfect, 1.0 = no match. 0.4 is moderate.
    minMatchCharLength: 3,
    shouldSort: true,
  });

  // Pass 1: exact normalized match.
  const saByNormalized = new Map<string, (typeof saKeyIndex)[number]>();
  for (const entry of saKeyIndex) saByNormalized.set(entry.normalized, entry);

  const matchedDrugIds = new Set<string>();
  for (const drug of drugKeyEntries) {
    const hit = saByNormalized.get(drug.normalized);
    if (!hit) continue;
    const saRow = saRows[hit.idx];
    if (saRow.saLink) {
      matchedLinks.set(drug.id, saRow.saLink);
      matchedDrugIds.add(drug.id);
    }
  }

  // Pass 2: Fuse fuzzy fallback for anything that didn't hit exactly.
  for (const drug of drugKeyEntries) {
    if (matchedDrugIds.has(drug.id)) continue;
    const result = fuse.search(drug.normalized);
    const top = result[0];
    if (!top || top.score == null) continue;
    // 0.4 in fuse's score=0..1 means up to ~40% edit distance. Re-tighten below.
    if (top.score > 0.3) continue; // stricter cutoff for fuzzy
    const saRow = saRows[top.item.idx];
    if (saRow.saLink) {
      matchedLinks.set(drug.id, saRow.saLink);
      matchedDrugIds.add(drug.id);
    }
  }

  for (const drug of drugs) {
    if (drug.isLimitedUse && !matchedLinks.has(drug.id)) {
      unmatchedLimitedUseIds.push(drug.id);
    }
  }

  return {
    matchedLinks,
    unmatchedLimitedUseIds,
    hadMisses: unmatchedLimitedUseIds.length > 0,
  };
}
