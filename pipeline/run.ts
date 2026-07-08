#!/usr/bin/env tsx
/**
 * Pipeline orchestrator.
 *
 * End-to-end run:
 *   1. Download PDDF zip + extract CSV
 *   2. Filter & aggregate per DIN/PIN into Drug records
 *   3. Download + parse LCA + RDP xlsx, scrape SA drug list HTML
 *   4. Enrich Drug records (LCA/RDP group membership, SA links, related DINs)
 *   5. Build MiniSearch index, companion data, meta
 *   6. Write artifacts to data-cache/ (build-time) and public/data/ (runtime)
 *
 * Usage:
 *   npx tsx pipeline/run.ts                # full run, default URLs
 *   MEDSEARCH_AS_OF=2024-12-31 npx tsx pipeline/run.ts    # reproducible
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fetchLcaXlsx,
  fetchPddfCsv,
  fetchRdpXlsx,
  fetchSaListHtml,
  parseSaListRows,
  withRetry,
} from './sources.js';
import { streamActiveBuckets, bucketsToDrugs } from './parse.js';
import { applyLcaRdpEnrichment, buildLcaRdpEnrichment } from './enrich-lca-rdp.js';
import { matchSpecialAuthority } from './enrich-sa.js';
import { attachRelatedDins } from './group-related.js';
import { asOfIso } from './helpers.js';
import { buildSearchIndex, writeIndexArtifacts } from './index-builder.js';

// --- Config -----------------------------------------------------------------

const DATA_DIR = process.env.MEDSEARCH_DATA_DIR ?? './data-cache';
const PUBLIC_DATA_DIR = process.env.MEDSEARCH_PUBLIC_DATA_DIR ?? './public/data';
const PDDF_URL = process.env.MEDSEARCH_PDDF_URL ?? 'https://www.health.gov.bc.ca/pharmacare/outgoing/pddf.zip';

// The LCA/RDP file URLs change every release (date-stamped filenames).
// We scrape them from the landing page at runtime so we always use the latest
// available file without hard-coding brittle URLs.
const LCA_LANDING = 'https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/pharmacies/low-cost-alternative-lca-and-reference-drug-program-rdp-data-files';
const SA_LIST_URL = 'https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/programs/special-authority/sa-drug-list';

async function findFirstXlsxUrl(landing: string, kind: 'lca' | 'rdp'): Promise<string> {
  // Only the network fetch is retry-eligible — the regex runs over the
  // downloaded bytes and a `Could not find …` throw there is a layout
  // change, not a transient outage. Retrying it would only burn CI
  // budget and silently mask a real regression.
  const html = await withRetry(async () => {
    const res = await fetch(landing, {
      headers: { 'user-agent': 'MedSearch/0.1 (+https://github.com/buffy/medsearch)' },
    });
    if (!res.ok) throw new Error(`Failed to fetch LCA/RDP landing page: ${res.status}`);
    return res.text();
  }, `fetch ${kind} landing`);
  const re = new RegExp(`href="([^"]*${kind}_current[^"]*\\.xlsx?)"`, 'i');
  const m = re.exec(html);
  if (!m) throw new Error(`Could not find ${kind} xlsx URL on landing page`);
  const href = m[1];
  return /^https?:/i.test(href) ? href : 'https://www2.gov.bc.ca' + (href.startsWith('/') ? href : '/' + href);
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  // As-of date: prefer explicit `MEDSEARCH_AS_OF` for reproducibility,
  // falling back to "today" for scheduled CI runs (where the env var is
  // unset or empty).
  const asOfEnv = (process.env.MEDSEARCH_AS_OF ?? '').trim();
  const asOf = asOfEnv ? new Date(asOfEnv) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(
      `Invalid MEDSEARCH_AS_OF="${process.env.MEDSEARCH_AS_OF}". Use YYYY-MM-DD.`,
    );
  }
  const asOfStr = asOfIso(asOf);
  console.log(`[pipeline] as-of date: ${asOfStr}`);

  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(PUBLIC_DATA_DIR, { recursive: true });

  // 1. PDDF
  console.log(`[pipeline] fetching PDDF…`);
  const fetchedAt = new Date().toISOString();
  const csvPath = await fetchPddfCsv(PDDF_URL, DATA_DIR, join(DATA_DIR, 'pddf.csv'));

  // 2. Filter + aggregate
  console.log(`[pipeline] parsing CSV…`);
  const buckets = await streamActiveBuckets(csvPath, asOf);
  let drugs = bucketsToDrugs(buckets);
  console.log(`[pipeline] aggregated ${drugs.length} active drugs from ${buckets.size} base DIN/PIN rows`);

  // 3. LCA / RDP + SA
  console.log(`[pipeline] fetching LCA, RDP, SA list…`);
  const [lcaUrl, rdpUrl] = await Promise.all([
    findFirstXlsxUrl(LCA_LANDING, 'lca'),
    findFirstXlsxUrl(LCA_LANDING, 'rdp'),
  ]);
  const [lcaRows, rdpRows, saHtml] = await Promise.all([
    fetchLcaXlsx(lcaUrl, DATA_DIR),
    fetchRdpXlsx(rdpUrl, DATA_DIR),
    fetchSaListHtml(SA_LIST_URL, DATA_DIR),
  ]);
  console.log(`[pipeline] LCA rows=${lcaRows.length} RDP rows=${rdpRows.length}`);

  const saRows = parseSaListRows(saHtml);
  console.log(`[pipeline] SA list rows=${saRows.length}`);

  // 4. Enrich
  const lcaRdp = buildLcaRdpEnrichment(lcaRows, rdpRows);
  drugs = applyLcaRdpEnrichment(drugs, lcaRdp);
  const saResult = matchSpecialAuthority(drugs, saRows);
  if (saResult.hadMisses) {
    console.warn(
      `[pipeline] WARNING: ${saResult.unmatchedLimitedUseIds.length} SA-flagged drugs could not be matched to criteria links — falling back to general SA directory link`,
    );
  } else {
    console.log(`[pipeline] all SA-flagged drugs matched to criteria links`);
  }
  for (const d of drugs) {
    if (saResult.matchedLinks.has(d.id)) {
      d.saLink = saResult.matchedLinks.get(d.id)!;
    }
  }
  drugs = attachRelatedDins(drugs);

  // 5. Index
  console.log(`[pipeline] building MiniSearch index…`);
  const index = await buildSearchIndex(drugs, asOf, {
    pddfUrl: PDDF_URL,
    fetchedAt,
  });
  await writeIndexArtifacts(index, PUBLIC_DATA_DIR);
  console.log(
    `[pipeline] search-index.json size=${(index.serializedSizeBytes / 1024).toFixed(0)} KB, companion=${index.companion.length} rows`,
  );

  // 6. Build-time data cache (read via `fs` at Next.js build)
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, 'drugs.json'), JSON.stringify(drugs));
  await writeFile(
    join(DATA_DIR, 'unmatched-sa.json'),
    JSON.stringify({ count: saResult.unmatchedLimitedUseIds.length, ids: saResult.unmatchedLimitedUseIds }),
  );

  const summary = {
    asOf: asOfStr,
    drugCount: drugs.length,
    saMatched: drugs.filter((d) => d.saLink != null).length,
    saTotal: drugs.filter((d) => d.isLimitedUse).length,
    inLca: drugs.filter((d) => d.inLcaCategory || d.lcaCategory != null).length,
    inRdp: drugs.filter((d) => d.inRdpCategory || d.rdpCategory != null).length,
    searchIndexKB: Math.round(index.serializedSizeBytes / 1024),
  };
  console.log(`[pipeline] DONE summary=${JSON.stringify(summary)}`);
}

main().catch((err) => {
  console.error(`[pipeline] FAILED`, err);
  process.exit(1);
});

