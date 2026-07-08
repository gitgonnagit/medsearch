#!/usr/bin/env node
/**
 * Merge the emitter's `out-static/` into Next.js's `out/`.
 *
 * Used after `next build` so the search home + about (Next.js) live alongside
 * tens of thousands of drug pages (custom emitter) in a single deploy
 * directory. Idempotent and overwrite-safe: if `out-static/` doesn't exist
 * (e.g., smoke tests with `MEDSEARCH_DRUG_LIMIT=0`), this is a no-op.
 */

import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SRC = process.env.MEDSEARCH_STATIC_OUT_DIR ?? './out-static';
const DEST = process.env.MEDSEARCH_NEXT_OUT_DIR ?? './out';

if (!existsSync(SRC)) {
  console.log(`[merge] ${SRC} does not exist; nothing to merge`);
  process.exit(0);
}

console.log(`[merge] copying ${SRC} → ${DEST} (this can take several minutes on full datasets)…`);
mkdirSync(DEST, { recursive: true });
// `cp -RL` recursively copies files as plain inodes (follows symlinks,
// doesn't preserve hardlinks) — both of which GitHub Pages' deploy
// artifact scanner explicitly rejects. Manifested once `out/drug/` grew
// from ~5k to ~60k pages (commit a66e6e9 dropped `MEDSEARCH_DRUG_LIMIT`).
// `execFileSync` (vs. `execSync` + `shell:'/bin/sh'`) avoids spawning a
// shell and removes shell-injection risk if SRC/DEST contain `$`/`;`/backticks.
execFileSync('cp', ['-RL', `${SRC}/.`, `${DEST}/`], { stdio: 'inherit' });
console.log(`[merge] copy complete`);

// Defensive: count symlinks and hardlinks in a single tree walk. `cp -RL`
// should already produce only plain inodes; if anything slipped through,
// fail CI fast (Pages deploy would surface this much later).
const { totalBytes, symlinks, hardlinks } = walkStats(DEST);
if (symlinks || hardlinks) {
  console.error(
    `[merge] FAILED ${symlinks} symlink(s) and ${hardlinks} hardlink(s) survived 'cp -RL' in ${DEST}. ` +
      `Refusing to upload an artifact GitHub Pages' deploy step will reject.`,
  );
  process.exit(1);
}
console.log(`[merge] verify: 0 symlinks, 0 hardlinks ✓`);

// Quiet cleanup so future runs don't accumulate stale static copies in CI.
try {
  rmSync(SRC, { recursive: true, force: true });
} catch {
  /* best effort */
}

const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
console.log(`[merge] merged ${SRC} → ${DEST}, total size ~${sizeMB} MB`);

/** Single tree walk that returns `totalBytes`, `symlinks`, `hardlinks`.
 *  Merging the previously-separate `approximateDirSize` + `countLinks`
 *  traversals saves one full pass over the 60k drug-page tree
 *  (~10–30 s on GHA's warm disk). */
function walkStats(dir) {
  let totalBytes = 0;
  let symlinks = 0;
  let hardlinks = 0;
  walk(dir);
  return { totalBytes, symlinks, hardlinks };

  function walk(p) {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks++;
      } else if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const s = statSync(full);
        totalBytes += s.size;
        // `nlink` includes the canonical directory entry, so >1 means the
        // inode is shared with at least one other path (a hardlink).
        if (s.nlink > 1) hardlinks++;
      }
    }
  }
}
