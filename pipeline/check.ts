#!/usr/bin/env tsx
/**
 * Pipeline smoke check. Reads the most recent pipeline outputs and prints a
 * short summary of health metrics. Suitable for use as a CI step before
 * deploying.
 */

import { stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.MEDSEARCH_DATA_DIR ?? './data-cache';
const PUBLIC_DATA_DIR = process.env.MEDSEARCH_PUBLIC_DATA_DIR ?? './public/data';

interface CheckRow {
  file: string;
  exists: boolean;
  bytes: number | null;
}

async function check(file: string): Promise<CheckRow> {
  if (!existsSync(file)) return { file, exists: false, bytes: null };
  const s = await stat(file);
  return { file, exists: true, bytes: s.size };
}

async function main(): Promise<void> {
  const rows: CheckRow[] = [];
  for (const f of [
    join(DATA_DIR, 'drugs.json'),
    join(PUBLIC_DATA_DIR, 'search-index.json'),
    join(PUBLIC_DATA_DIR, 'related.json'),
    join(PUBLIC_DATA_DIR, 'meta.json'),
  ]) {
    rows.push(await check(f));
  }
  for (const r of rows) {
    const size = r.bytes == null ? 'missing' : `${(r.bytes / 1024).toFixed(0)} KB`;
    console.log(`${r.exists ? 'OK ' : '!! '} ${r.file}  ${size}`);
    if (!r.exists) {
      console.error('Missing required output. Run `npm run pipeline` first.');
      process.exit(2);
    }
  }
  // Quick drug-count sanity from meta.json.
  const metaRaw = await readFile(join(PUBLIC_DATA_DIR, 'meta.json'), 'utf8');
  const meta = JSON.parse(metaRaw);
  if (!meta.drugCount || meta.drugCount < 1000) {
    console.error(
      `drugCount (${meta.drugCount}) is unexpectedly low. Source may not have parsed correctly.`,
    );
    process.exit(2);
  }
  console.log(`OK drugCount=${meta.drugCount}, schemaVersion=${meta.schemaVersion}`);
}

main().catch((err) => {
  console.error('check failed', err);
  process.exit(1);
});
