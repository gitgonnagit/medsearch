#!/usr/bin/env tsx
/**
 * Drug detail HTML emitter.
 *
 * Why this exists: Next.js `output: 'export'` builds ~60,000 detail pages through
 * 60,000 React tree renders, which OOMs / times out on the GitHub Actions free
 * tier (7 GB RAM, 90-min cap). We bypass Next.js for the detail route by
 * reading `data-cache/drugs.json` and rendering each drug's HTML directly
 * via a template literal. The result is one fully self-contained, zero-JS
 * `.html` file per DIN — exactly what the spec requires for "no fetch on
 * detail click, every page loads instantly".
 *
 * The Next.js build is reserved for `/` (search home) and `/about/`. After
 * the Next.js static export completes, this emitter's output is merged on
 * top of `out/` so drug detail URLs resolve to the emitter's HTML.
 *
 * Run after the pipeline (`npm run pipeline && npm run pipeline:emit`) and
 * before `next build` so the static output dir is ready.
 *
 * Env:
 *   MEDSEARCH_DATA_DIR         — pipeline output dir (default `./data-cache`)
 *   MEDSEARCH_STATIC_OUT_DIR   — where this emitter writes (default `./out-static`)
 *   MEDSEARCH_DRUG_LIMIT       — cap number of pages emitted (dev smoke tests)
 *   NEXT_PUBLIC_BASE_PATH      — emitted absolute paths get this prefix
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Drug, PlanCoverage, SiteMeta } from './types.js';
import { computeCostBreakdown } from './helpers.js';

const DATA_DIR = process.env.MEDSEARCH_DATA_DIR ?? './data-cache';
const STATIC_OUT_DIR = process.env.MEDSEARCH_STATIC_OUT_DIR ?? './out-static';
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const DRUG_LIMIT = process.env.MEDSEARCH_DRUG_LIMIT
  ? parseInt(process.env.MEDSEARCH_DRUG_LIMIT, 10)
  : null;
const CSS_FILENAME = 'medsearch.css';

/** Min number of raw `await writeFile` workers (chunked parallel write). */
const WRITE_CONCURRENCY = 64;

/** Cap on related-drug cards rendered per detail page. Without this,
 *  wide `genericGroupKey` buckets (e.g., 4,700+ rows from an "unknown
 *  generic drug" placeholder all sharing the same genericName) inflate
 *  the artifact from ~300 MB to ~12 GB, which `actions/deploy-pages@v4`
 *  rejects on its 10 GB hard cap. Buckets larger than this render a
 *  "(showing N of M)" hint in the section heading. Env-tunable via
 *  MEDSEARCH_MAX_RELATED for CI smoke tests. */
const MAX_RELATED_DRUGS = process.env.MEDSEARCH_MAX_RELATED
  ? parseInt(process.env.MEDSEARCH_MAX_RELATED, 10)
  : 24;

async function loadDrugs(): Promise<Drug[]> {
  const path = join(DATA_DIR, 'drugs.json');
  if (!existsSync(path)) {
    throw new Error(
      `drugs.json not found at ${path}. Run \`npm run pipeline\` first.`,
    );
  }
  return JSON.parse(await readFile(path, 'utf8')) as Drug[];
}

async function loadMeta(): Promise<SiteMeta | null> {
  for (const path of [join(DATA_DIR, 'meta.json'), join('./public/data', 'meta.json')]) {
    if (existsSync(path)) {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as SiteMeta;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function loadCss(): Promise<string> {
  const path = join(process.cwd(), 'src/app/globals.css');
  if (!existsSync(path)) {
    throw new Error(`globals.css not found at ${path}.`);
  }
  return await readFile(path, 'utf8');
}

// --- HTML escape ----------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const HTML_RE = /[&<>"']/g;
function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(HTML_RE, (c) => HTML_ENTITIES[c] ?? c);
}

// --- Site header / footer templates --------------------------------------

function renderHeader(base: string): string {
  return `<header class="site-header">
  <div class="container site-header__inner">
    <a href="${base}/" class="site-header__brand">
      <svg class="site-header__logo" viewBox="0 0 24 24" role="img" aria-label="MedSearch" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="11" stroke="currentColor" stroke-width="2" />
        <rect x="6" y="10" width="12" height="6" rx="3" fill="currentColor" />
      </svg>
      <span>MedSearch</span>
    </a>
    <nav class="site-header__nav" aria-label="Primary">
      <a href="${base}/">Search</a>
      <a href="${base}/about/">About</a>
    </nav>
  </div>
</header>`;
}

function renderFooter(meta: SiteMeta | null, base: string): string {
  const generatedText = meta?.generatedAt ? humanDate(meta.generatedAt) : 'unknown';
  const asOf = meta?.asOfDate
    ? ` <span class="text-muted">(as-of ${esc(meta.asOfDate)})</span>`
    : '';
  return `<footer class="site-footer">
  <div class="container">
    <p>
      <strong>Data last updated:</strong> ${esc(generatedText)}${asOf}
    </p>
    <p>
      Drug coverage and pricing data is sourced from BC PharmaCare public
      downloadable files and may not reflect the most current or complete
      information. Provided for informational and reference purposes only;
      not a substitute for verifying coverage directly with PharmaCare or a
      patient&apos;s actual plan.
    </p>
    <p>
      <a href="${base}/about/">Data sources &amp; methodology</a>
      &middot; Not affiliated with the Government of British Columbia.
    </p>
  </div>
</footer>`;
}

function humanDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-CA', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

// --- Drug body sections ---------------------------------------------------

function renderPlanRow(p: PlanCoverage): string {
  const klass =
    p.coverageLabel === 'Covered'
      ? 'badge--covered'
      : p.coverageLabel === 'Limited Use'
        ? 'badge--limited'
        : 'badge--not-covered';
  const price = p.displayPrice == null ? '&#8212;' : `$${p.displayPrice.toFixed(2)}`;
  const desc = p.planDescription ? `<div class="text-small text-muted">${esc(p.planDescription)}</div>` : '';
  const maxDays = p.maxDaysSupply != null ? `<div class="text-small">Max days supply: ${esc(String(p.maxDaysSupply))}</div>` : '';
  const qty = p.qtyLimit ? `<div class="text-small">Qty limit: ${esc(p.qtyLimit)}</div>` : '';
  const rdpCat = p.rdpCategory ? `<div class="text-small text-muted">RDP: ${esc(p.rdpCategory)}</div>` : '';
  return `<tr>
  <td>
    <strong>${esc(p.plan)}</strong>
    ${desc}
  </td>
  <td><span class="badge ${klass}">${esc(p.coverageLabel)}</span></td>
  <td class="numeric">${price}</td>
  <td>${maxDays}${qty}${rdpCat}</td>
</tr>`;
}

function renderPlanCoverageTable(plans: PlanCoverage[]): string {
  if (plans.length === 0) {
    return `<p class="text-muted text-small">No active PharmaCare plan coverage on file for this DIN/PIN.</p>`;
  }
  return `<table class="coverage-table" aria-label="Plan coverage and pricing">
  <thead>
    <tr>
      <th>Plan</th>
      <th>Status</th>
      <th class="numeric">Max reimbursement</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    ${plans.map(renderPlanRow).join('\n')}
  </tbody>
</table>`;
}

function renderSaCallout(d: Drug): string {
  if (!d.isLimitedUse) return '';
  const hasDirect = d.saLink != null;
  const target = esc(hasDirect ? d.saLink! : d.saDirectoryLink);
  const label = hasDirect ? 'Open the criteria and request form' : 'Browse the Special Authority drug list';
  // Tail is rendered raw HTML from ourselves (no user content), so we don't
  // re-escape it on output. genericName escaped ONCE here, then placed into
  // the HTML without a second esc() pass.
  const tail = hasDirect ? '.' : ` to find the criteria for ${esc(d.genericName)}.`;
  return `<div class="detail__callout detail__callout--warning">
  <div class="detail__callout-title">Special Authority required</div>
  <div>
    This drug requires Special Authority coverage under BC PharmaCare.
    <a href="${target}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>${tail}
  </div>
</div>`;
}

function renderPriceCallout(d: Drug): string {
  const showLca = d.inLcaCategory || d.lcaCategory != null;
  const showRdp = d.inRdpCategory || d.rdpCategory != null;
  if (!showLca && !showRdp) return '';
  const lines: string[] = [];
  if (showLca && d.lcaCategory) {
    lines.push(
      `<div><strong>Low Cost Alternative (LCA):</strong> Member of the <em>${esc(d.lcaCategory)}</em> category. PharmaCare reimburses up to the LCA price for this category.</div>`,
    );
  }
  if (showRdp && d.rdpCategory) {
    lines.push(
      `<div><strong>Reference Drug Program (RDP):</strong> Member of the <em>${esc(d.rdpCategory)}</em> category. RDP price applies (subject to plan-exclusion rules).</div>`,
    );
  }
  return `<div class="detail__callout">${lines.join('\n')}</div>`;
}

const fmtCurrency = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Top-of-page "Patient Pays" panel. The user-facing headline is the
 * patient share (30% post-deductible) for the cheapest daily cost across
 * the drug's active plans: monthly + 3-month totals. Beneath the headline
 * we surface the source plan + unit math, full-cost reference, and a
 * small disclosure when `maxDailyQty === 1` on a unit-dose form
 * (injection / patch / inhaler / vial / etc.) so users see "1 unit/day"
 * rather than a 30× implication.
 */
function renderCostCallout(d: Drug): string {
  const breakdown = computeCostBreakdown(d.plans, d.dosageForm);
  if (!breakdown.source) return '';
  const { source, fullMonthly, fullThreeMonth, patientMonthly, patientThreeMonth, unitDisclosure } =
    breakdown;
  return `
    <section class="cost-callout">
      <div class="cost-callout__eyebrow">Patient pays (after deductible, 30% coverage)</div>
      <div class="cost-callout__amounts">
        <div class="cost-callout__row">
          <span class="cost-callout__label">Monthly</span>
          <span class="cost-callout__amount">${fmtCurrency(patientMonthly!)}</span>
        </div>
        <div class="cost-callout__row">
          <span class="cost-callout__label">3 Months</span>
          <span class="cost-callout__amount">${fmtCurrency(patientThreeMonth!)}</span>
        </div>
      </div>
      <div class="cost-callout__reference">
        Cheapest source plan <strong>${source.plan}</strong>: ${fmtCurrency(source.unitPrice)} per unit
        × ${source.unitsPerDay} unit/day = ${fmtCurrency(source.costPerDay)} per day.
        Reference full cost: ${fmtCurrency(fullMonthly!)} per month ($11 dispensing fee)
        and ${fmtCurrency(fullThreeMonth!)} per 3 months; the 30% above is what the patient pays
        once Fair PharmaCare's deductible is met.
      </div>${
        unitDisclosure
          ? `\n      <div class="cost-callout__disclosure">${esc(unitDisclosure)}</div>`
          : ''
      }
    </section>`;
}

function renderRelatedDrugs(d: Drug, allDrugs: Drug[]): string {
  // Compute "related" drugs inline from the canonical list (instead of reading
  // a separate sidecar) so the emitter is the source of truth here.
  if (allDrugs.length === 0 || !d.genericGroupKey) return '';
  // Sort the matching set so the visible N (where N = MAX_RELATED_DRUGS)
  // are the most variationally different — not just the first N by
  // parse.ts's alphabetical genericName encounter order, which is
  // arbitrary within a same-generic bucket and unhelpful when a
  // bucket spans several thousand rows (e.g. the "unknown generic drug"
  // placeholder group). Comparator falls through to brandName for the
  // common case where strength is null (covered by parse.ts's known
  // limitation); a future change that populates `strength` will get the
  // deterministic strength-driven order for free.
  const allMatching = allDrugs
    .filter((x) => x.genericGroupKey === d.genericGroupKey && x.id !== d.id)
    .sort((a, b) => {
      const s = (a.strength ?? '').localeCompare(b.strength ?? '');
      if (s !== 0) return s;
      return (a.brandName ?? '').localeCompare(b.brandName ?? '');
    });
  if (allMatching.length === 0) return '';
  // Cap rendered rows; the rest get a (showing N of M) hint in the heading.
  // See MAX_RELATED_DRUGS above for the size-bound rationale.
  const related = allMatching.slice(0, MAX_RELATED_DRUGS);
  const truncated = allMatching.length > related.length;

  const rows = related
    .map((r) => {
      const brandLine = r.brandName
        ? `<span class="result__brand">${esc(r.brandName)}</span><span class="result__generic">&mdash; ${esc(r.genericName)}</span>`
        : `<span class="result__brand">${esc(r.genericName)}</span>`;
      const meta: string[] = [`<span>DIN/PIN: <span class="text-mono">${esc(r.id)}</span></span>`];
      if (r.dosageForm) meta.push(`<span>${esc(r.dosageForm)}</span>`);
      if (r.manufacturer) meta.push(`<span>${esc(r.manufacturer)}</span>`);
      // Note: same basePath normalisation as the per-drug link below.
      return `<a href="${BASE_PATH}/drug/${encodeURIComponent(r.id)}/" class="result">
  <div class="result__title">${brandLine}</div>
  <div class="result__meta">
    ${meta.join('\n    ')}
  </div>
</a>`;
    })
    .join('\n');

  const suffix = truncated
    ? ` <span class="text-muted text-small">(showing ${related.length} of ${allMatching.length})</span>`
    : '';

  return `<section class="detail__section">
  <h2 class="detail__section-title">Other drugs with the same generic name${suffix}</h2>
  <div class="related-list">
    ${rows}
  </div>
</section>`;
}

function renderMeta(d: Drug): string {
  const items: string[] = [];
  const idLabel =
    d.idKind === 'din' ? 'Drug Identification Number' : 'Product Identification Number';
  items.push(
    `<span><dt>DIN/PIN ${esc(d.id)} &middot;</dt><dd> ${esc(idLabel)}</dd></span>`,
  );
  if (d.manufacturer) items.push(`<span><dt>Manufacturer</dt><dd> ${esc(d.manufacturer)}</dd></span>`);
  if (d.dosageForm) items.push(`<span><dt>Dosage form</dt><dd> ${esc(d.dosageForm)}</dd></span>`);
  if (d.benefitGroup) items.push(`<span><dt>Benefit group</dt><dd> ${esc(d.benefitGroup)}</dd></span>`);
  return items.join('\n      ');
}

// --- Per-drug page -------------------------------------------------------

function renderDrugPage(d: Drug, allDrugs: Drug[], meta: SiteMeta | null, base: string): string {
  const displayName = d.brandName ?? d.genericName;
  const title = `${displayName} (DIN/PIN ${d.id})`;
  const escapeTitle = esc(title);
  const description =
    `Coverage, pricing, and Special Authority status for ${displayName} ` +
    `(DIN/PIN ${d.id}) across BC PharmaCare plans.`;
  const canonical = `${base}/drug/${encodeURIComponent(d.id)}/`;
  const cssHref = `${base}/${CSS_FILENAME}`;
  const faviconHref = `${base}/favicon.svg`;
  const genericLine = d.brandName ? `<p class="detail__generic">${esc(d.genericName)}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeTitle} &middot; MedSearch</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${canonical}" />
  <link rel="stylesheet" href="${cssHref}" />
  <link rel="icon" type="image/svg+xml" href="${faviconHref}" />
  <meta name="theme-color" content="#fafafa" />
  <meta property="og:title" content="${escapeTitle}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:type" content="website" />
</head>
<body>
${renderHeader(base)}
<main>
  <article class="container detail">
    ${renderCostCallout(d)}
    <header class="detail__header">
      <p class="detail__eyebrow">DIN/PIN ${esc(d.id)} &middot; ${esc(d.idKind === 'din' ? 'Drug Identification Number' : 'Product Identification Number')}</p>
      <h1 class="detail__title">${esc(d.brandName ?? d.genericName)}</h1>
      ${genericLine}
      <dl class="detail__meta">
        ${renderMeta(d)}
      </dl>
      <p class="text-small text-muted" style="margin-top:16px">
        <a href="${esc(d.healthCanadaDpdUrl)}" target="_blank" rel="noopener noreferrer">View Health Canada monograph</a>
      </p>
    </header>
    ${renderSaCallout(d)}
    ${renderPriceCallout(d)}
    <section class="detail__section">
      <h2 class="detail__section-title">Plan-by-plan coverage</h2>
      ${renderPlanCoverageTable(d.plans)}
      <div class="detail__disclaimer" style="margin-top:16px">
        Prices shown are the maximum PharmaCare-recognized reimbursement per unit. They do not
        include pharmacy dispensing fees, deductibles, or local markups, and they are not an
        estimate of a specific patient&apos;s out-of-pocket cost.
      </div>
    </section>
    ${renderRelatedDrugs(d, allDrugs)}
    <p style="margin-top:32px"><a href="${base}/">&larr; Back to search</a></p>
  </article>
</main>
${renderFooter(meta, base)}
</body>
</html>
`;
}

// --- Concurrency-limited parallel writes --------------------------------

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function next(): Promise<void> {
    const idx = i++;
    if (idx >= items.length) return;
    await worker(items[idx]);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

// --- Main ---------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[emit] loading dataset from ${DATA_DIR}…`);
  const drugs = await loadDrugs();
  const meta = await loadMeta();
  console.log(`[emit] ${drugs.length} drugs loaded`);

  const drugsToEmit = DRUG_LIMIT != null ? drugs.slice(0, DRUG_LIMIT) : drugs;
  console.log(
    `[emit] emitting ${drugsToEmit.length} detail page${drugsToEmit.length === 1 ? '' : 's'} to ${STATIC_OUT_DIR}` +
      (DRUG_LIMIT != null ? ` (limited via MEDSEARCH_DRUG_LIMIT=${DRUG_LIMIT})` : ''),
  );

  // Write the shared CSS file once.
  const css = await loadCss();
  await mkdir(join(STATIC_OUT_DIR, 'drug'), { recursive: true });
  await writeFile(join(STATIC_OUT_DIR, CSS_FILENAME), css);
  console.log(`[emit] wrote shared CSS → ${join(STATIC_OUT_DIR, CSS_FILENAME)}`);

  const t0 = Date.now();
  await runPool(drugsToEmit, WRITE_CONCURRENCY, async (d) => {
    const html = renderDrugPage(d, drugs, meta, BASE_PATH);
    const outPath = join(STATIC_OUT_DIR, 'drug', d.id, 'index.html');
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, html);
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[emit] DONE — ${drugsToEmit.length} pages in ${elapsed}s`);
}

main().catch((err) => {
  console.error(`[emit] FAILED`, err);
  process.exit(1);
});
