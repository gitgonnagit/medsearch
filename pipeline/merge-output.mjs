#!/usr/bin/env node
/**
 * Merge the emitter's `out-static/` into Next.js's `out/`.
 *
 * Used after `next build` so the search home + about (Next.js) live alongside
 * tens of thousands of drug pages (custom emitter) in a single deploy
 * directory. Idempotent and overwrite-safe: if `out-static/` doesn't exist
 * (e.g., smoke tests with `MEDSEARCH_DRUG_LIMIT=0`), this is a no-op.
 */

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.env.MEDSEARCH_STATIC_OUT_DIR ?? './out-static';
const DEST = process.env.MEDSEARCH_NEXT_OUT_DIR ?? './out';

if (!existsSync(SRC)) {
  console.log(`[merge] ${SRC} does not exist; nothing to merge`);
  process.exit(0);
}

console.log(`[merge] copying ${SRC} → ${DEST} (this can take several minutes on full datasets)…`);
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true, dereference: false });
console.log(`[merge] copy complete`);

// Quiet cleanup so future runs don't accumulate stale static copies in CI.
try {
  rmSync(SRC, { recursive: true, force: true });
} catch {
  /* best effort */
}

const sizeMB = (approximateDirSize(DEST) / (1024 * 1024)).toFixed(1);
console.log(`[merge] merged ${SRC} → ${DEST}, total size ~${sizeMB} MB`);

/** Coarse, recursive dir size — used only for log display. */
function approximateDirSize(dir) {
  let total = 0;
  walk(dir);
  return total;

  function walk(p) {
    for (const entry of readdirSync(p)) {
      const child = join(p, entry);
      const s = statSync(child);
      if (s.isDirectory()) walk(child);
      else total += s.size;
    }
  }
}
