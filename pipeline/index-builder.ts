/**
 * MiniSearch index builder.
 *
 * Server-side we build the index once over the full Drug array, then
 * serialize it to JSON. The browser fetches the JSON and calls
 * `MiniSearch.loadJSON` to avoid any rebuild cost on first paint.
 */

import MiniSearch from 'minisearch';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CANONICAL_DOSAGE_FORMS, computePriceSummary } from './helpers.js';
import type { Drug, SearchCompanionRow, SiteMeta } from './types.js';

export interface IndexBuildResult {
  serializedIndex: string;
  companion: SearchCompanionRow[];
  meta: SiteMeta;
  serializedSizeBytes: number;
}

const SEARCH_FIELDS = ['brandName', 'genericName', 'manufacturer', 'dosageForm', 'id'];

export async function buildSearchIndex(
  drugs: Drug[],
  asOf: Date,
  source: { pddfUrl: string; fetchedAt: string },
): Promise<IndexBuildResult> {
  const docs = drugs.map((d) => ({
    id: d.id,
    brandName: d.brandName ?? '',
    genericName: d.genericName,
    manufacturer: d.manufacturer ?? '',
    dosageForm: d.dosageForm ?? '',
  }));

  const mini = new MiniSearch({
    idField: 'id',
    fields: SEARCH_FIELDS,
    storeFields: ['id', 'brandName', 'genericName', 'dosageForm', 'manufacturer'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { brandName: 2, genericName: 1, dosageForm: 1.5, manufacturer: 0.5, id: 1.0 },
      combineWith: 'AND',
    },
  });

  await mini.addAllAsync(docs, { chunkSize: 500 });

  const serializedIndex = JSON.stringify(mini.toJSON());
  const companion: SearchCompanionRow[] = drugs.map((d) => ({
    id: d.id,
    brandName: d.brandName,
    genericName: d.genericName,
    dosageForm: d.dosageForm,
    canonicalDosageForm: d.canonicalDosageForm,
    manufacturer: d.manufacturer,
    isLimitedUse: d.isLimitedUse,
    inLcaCategory: d.inLcaCategory || d.lcaCategory != null,
    inRdpCategory: d.inRdpCategory || d.rdpCategory != null,
    // Precomputed once at pipeline time (~30-50 B/drug × ~16K drugs ≈
    // ~600 KB added to companion.json) so the listing row renders with
    // no per-keystroke cost math. Returns null when no plan has a
    // positive displayPrice; the row then shows a "not covered" tag
    // instead of the price block.
    priceSummary: computePriceSummary(
      d.plans,
      d.dosageForm,
      d.canonicalDosageForm,
      // Pass genericName so `computePriceSummary` can apply
      // category-specific rules like the NP force-include for diabetes
      // drugs without forcing every caller to thread it through.
      d.genericName,
    ),
  }));

  const meta: SiteMeta = {
    generatedAt: new Date().toISOString(),
    asOfDate: asOf.toISOString().slice(0, 10),
    drugCount: drugs.length,
    source: { ...source, fetchedAt: source.fetchedAt },
    schemaVersion: 1,
  };

  return {
    serializedIndex,
    companion,
    meta,
    serializedSizeBytes: serializedIndex.length,
  };
}

/** Write index + companion + meta to disk. */
export async function writeIndexArtifacts(
  out: IndexBuildResult,
  publicDataDir: string,
): Promise<void> {
  await mkdir(publicDataDir, { recursive: true });
  await writeFile(join(publicDataDir, 'search-index.json'), out.serializedIndex);
  await writeFile(
    join(publicDataDir, 'related.json'),
    JSON.stringify(out.companion),
  );
  await writeFile(
    join(publicDataDir, 'meta.json'),
    JSON.stringify(out.meta, null, 2),
  );
  // Single source of truth for the 8 canonical dosage-form categories. The
  // frontend fetches this on load to populate the home-page chip strip —
  // keeps frontend and pipeline reading the same labels.
  await writeFile(
    join(publicDataDir, 'canonical-dosage-forms.json'),
    JSON.stringify(CANONICAL_DOSAGE_FORMS),
  );
  void dirname;
}
