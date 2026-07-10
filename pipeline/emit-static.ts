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
import { computeCostBreakdown, cleanedMoleculeName } from './helpers.js';

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
 * Top-of-page "Cost at the pharmacy" panel. Two panes:
 *   1. **No PharmaCare coverage** — what patients pay out-of-pocket at
 *      100% (drug cost + $11 dispensing fee).
 *   2. **Fair PharmaCare** — what enrolled patients pay once their
 *      family deductible is met (30% share of the same drug cost + fee).
 *
 * Both panes use the cheapest source plan's `displayPrice` so the math
 * is internally consistent (the reference row below spells out which
 * plan and which unit math the figures come from). Each pane carries
 * its own "Includes $11 dispensing fee per fill" footnote so the fee
 * is visible from a glance rather than hidden in fine print.
 *
 * The `unitDisclosure` (raw maxDailyQty === 1 + unit-dose form) is
 * surfaced as a separate `.cost-callout__disclosure` line below the
 * reference so users see "1 unit/day" rather than a 30× implication.
 */
function renderCostCallout(d: Drug): string {
  const breakdown = computeCostBreakdown(d.plans, d.dosageForm);
  if (!breakdown.source) return '';
  const { source, fullMonthly, fullThreeMonth, patientMonthly, patientThreeMonth, unitDisclosure } =
    breakdown;
  return `
    <section class="cost-callout">
      <div class="cost-callout__eyebrow">Cost at the pharmacy</div>
      <div class="cost-callout__panes">
        <div class="cost-callout__pane cost-callout__pane--no-coverage">
          <div class="cost-callout__pane-header">No PharmaCare coverage</div>
          <div class="cost-callout__pane-sub">Patient pays 100%</div>
          <div class="cost-callout__pane-amounts">
            <div class="cost-callout__row">
              <span class="cost-callout__label">Monthly</span>
              <span class="cost-callout__amount">${fmtCurrency(fullMonthly!)}</span>
            </div>
            <div class="cost-callout__row">
              <span class="cost-callout__label">3 Months</span>
              <span class="cost-callout__amount">${fmtCurrency(fullThreeMonth!)}</span>
            </div>
          </div>
          <div class="cost-callout__pane-note">Includes the $11 dispensing fee per fill.</div>
        </div>

        <div class="cost-callout__pane cost-callout__pane--fair-pharmacare">
          <div class="cost-callout__pane-header">Fair PharmaCare</div>
          <div class="cost-callout__pane-sub">After deductible met, 30% share</div>
          <div class="cost-callout__pane-amounts">
            <div class="cost-callout__row">
              <span class="cost-callout__label">Monthly</span>
              <span class="cost-callout__amount">${fmtCurrency(patientMonthly!)}</span>
            </div>
            <div class="cost-callout__row">
              <span class="cost-callout__label">3 Months</span>
              <span class="cost-callout__amount">${fmtCurrency(patientThreeMonth!)}</span>
            </div>
          </div>
          <div class="cost-callout__pane-note">Includes 30% of the $11 dispensing fee per fill.</div>
        </div>
      </div>
      <div class="cost-callout__reference">
        Cheapest source plan <strong>${source.plan}</strong>: ${fmtCurrency(source.unitPrice)} per unit
        × ${source.unitsPerDay} unit/day = ${fmtCurrency(source.costPerDay)} per day.
      </div>${
        unitDisclosure
          ? `\n      <div class="cost-callout__disclosure">${esc(unitDisclosure)}</div>`
          : ''
      }
    </section>`;
}

/**
 * Visual classifier for one drug's role within the "Other drugs with
 * the same generic name" section. The user's mental model collapses
 * all branded-generics (Apo-Atorvastatin, Teva-Atorvastatin, …) under
 * one "generic" identifier per strength; brand-name products
 * (Lipitor, Crestor) keep their own identifier per strength.
 *
 *  - kind = "generic": brandName is null OR brandName (cleaned) equals
 *                     / contains the cleaned molecule base. Apo-, Teva-
 *                     Atorvastatin still share the molecule "atorvastatin".
 *  - kind = "brand":  brandName is set and is something other than the
 *                     molecule base.
 *
 * The cleaned molecule base is computed in pipeline/helpers.ts so the
 * dedup pass here stays in lock-step with `genericGroupKey`'s.
 */
interface RelatedClass {
  kind: 'generic' | 'brand';
  /** Stable, lowercased, used as part of the dedup key for cards. */
  identifier: string;
  /** Display form (title-cased) used in card titles. */
  displayIdentifier: string;
}

function classifyRelated(d: Drug): RelatedClass {
  const baseLc = cleanedMoleculeName(d.genericName);
  const brandLc = (d.brandName ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const brandedGeneric =
    !!brandLc &&
    (brandLc === baseLc || (baseLc.length >= 6 && brandLc.includes(baseLc)));
  if (!brandLc || brandedGeneric) {
    return {
      kind: 'generic',
      identifier: baseLc,
      displayIdentifier: titleCase(baseLc),
    };
  }
  return {
    kind: 'brand',
    identifier: brandLc,
    displayIdentifier: titleCase(d.brandName!),
  };
}

/** Title-case lowercase strings, breaking at whitespace / hyphens /
 *  apostrophes so "apo-atorvastatin" → "Apo-Atorvastatin", "lipitor"
 *  → "Lipitor". */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-'])[a-z]/g, (m) => m.toUpperCase());
}

/** Effective strength for grouping: `drug.strength` from the parsed
 *  record when populated, otherwise extracted from the raw
 *  `genericName` string. The BC PharmaCare PDDF does not surface
 *  strength as a dedicated column, so `parse.ts` deliberately leaves
 *  `drug.strength` null and embeds the strength inside `genericName`
 *  (e.g. "ATORVASTATIN CALCIUM 10 MG TA"). Without this fallback the
 *  dedup key in `renderRelatedDrugs` is silent on strength and every
 *  dose variant of the same generic collapses into a single card —
 *  undoing the user's explicit "different generic strengths" ask.
 *  Uses the same strength-token regex pattern as helpers.STRENGTH_TOKEN
 *  inlined here, so the emitter stays self-contained on dedup
 *  decisions. */
function effectiveStrength(d: Drug): string | null {
  if (d.strength) return d.strength;
  // Strengths can be plain oral doses ("10 mg"), concentration-time
  // ("5 mg/ml"), or weight-adjusted ("5 mg/kg"). Keep the per-mL /
  // per-kg tail attached so liquid-strength card titles don't render
  // with a trailing "/" (the previous regex stopped at the slash,
  // capturing "10 mg/" from "10 mg/ml" and surfacing "Atorvastatin
  // 10 mg/" — ugly).
  const m = /\b(\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|mL|iu|%|u|units?|mmol)(?:\/(?:ml|mL|ML|kg|m\^?2))?)\b/i.exec(d.genericName);
  if (!m) return null;
  return m[1].trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Strength ordering key: extract leading numeric portion so "10 mg",
 *  "20 mg", "100 mg" sort by magnitude instead of lexicographically
 *  (which would order "10 mg" after "100 mg"). Non-numeric strengths
 *  sort to the tail so they don't pre-empt the dominant numeric set. */
function strengthOrderKey(s: string | null): number {
  if (!s) return Number.POSITIVE_INFINITY;
  const m = /^(\d+(?:\.\d+)?)/.exec(s.trim());
  return m ? parseFloat(m[1]) : Number.POSITIVE_INFINITY;
}

/** Single card in the related-list grid. Each card aggregates ≥1
 *  DIN sharing (kind, identifier, strength, dosageForm). */
interface RelatedCard {
  kind: 'generic' | 'brand';
  identifier: string;
  displayIdentifier: string;
  strength: string | null;
  dosageForm: string | null;
  dins: Drug[];
  representativeDin: Drug;
  coverageKind: 'Covered' | 'Limited Use' | 'Not covered';
  count: number;
}

/** Pick a click-through representative DIN per card: cheapest
 *  (displayPrice × maxDailyQty) across plans whose status indicates
 *  actual coverage ("Covered" or "Limited Use"), fallback to smallest
 *  DIN id lexically. Avoids landing on an obscure high-priced DIN
 *  when several are available in the same strength bucket, and
 *  avoids picking a Not-covered row whose displayPrice happens to
 *  be positive (shouldn't happen post-literal-zero fix, but defensive
 *  — `computePriceSummary` filters on label so we mirror that here). */
function pickRepresentativeDin(
  drugs: Drug[],
  coverageKind: 'Covered' | 'Limited Use' | 'Not covered',
): Drug {
  // Per the reviewer flag: a card whose badge says "Covered" must not
  // link into a Limited-Use-only DIN — UX mismatch. Two-pass picker:
  //   Pass 1 — cheapest DIN whose cheapest positive-price plan's
  //            coverageLabel matches the card's coverageKind.
  //   Pass 2 — cheapest positive-price DIN with any non-Not-covered
  //            label, if pass 1 found nothing.
  //   Pass 3 — smallest DIN id lexically, defensive fallback.
  const cheapestOf = (kind: PlanCoverage['coverageLabel'] | 'any'): Drug | null => {
    let best: { d: Drug; cost: number } | null = null;
    for (const d of drugs) {
      for (const p of d.plans) {
        if (p.displayPrice == null || p.displayPrice <= 0) continue;
        if (kind !== 'any' && p.coverageLabel !== kind) continue;
        if (kind === 'any' && p.coverageLabel === 'Not covered') continue;
        const units = p.maxDailyQty != null && p.maxDailyQty > 0 ? p.maxDailyQty : 1;
        const cost = p.displayPrice * units;
        if (!best || cost < best.cost) best = { d, cost };
      }
    }
    return best ? best.d : null;
  };

  // Pass 1: strict match for positive-coverage states only.
  if (coverageKind === 'Covered' || coverageKind === 'Limited Use') {
    const strict = cheapestOf(coverageKind);
    if (strict) return strict;
  }
  // Pass 2: any non-Not-covered positive-price plan.
  const any = cheapestOf('any');
  if (any) return any;
  // Pass 3: smallest DIN id lexically.
  return [...drugs].sort((a, b) => a.id.localeCompare(b.id))[0];
}

/** Derive a card-level coverage badge from the union of underlying
 *  DINs' plan rows. "Covered" wins if any plan row is Covered;
 *  "Limited Use" wins if any is Limited Use and no Covered; else
 *  "Not covered". This is the user's "indicate that generic
 *  atorvastatin is covered" surface — a single badge per card
 *  rather than a per-DIN plan table. */
function coverageKindOf(drugs: Drug[]): 'Covered' | 'Limited Use' | 'Not covered' {
  let seenCovered = false;
  let seenLimited = false;
  for (const d of drugs) {
    for (const p of d.plans) {
      if (p.coverageLabel === 'Covered') seenCovered = true;
      else if (p.coverageLabel === 'Limited Use') seenLimited = true;
    }
  }
  if (seenCovered) return 'Covered';
  if (seenLimited) return 'Limited Use';
  return 'Not covered';
}

/** Sort cards: generics before brands (the user's mental flow —
 *  "generic atorvastatin is covered", then "Lipitor follows as the
 *  brand-name branch"), then ascending strength within each kind, then
 *  alphabetical identifier as the deterministic tiebreaker. */
function sortRelatedCards(a: RelatedCard, b: RelatedCard): number {
  if (a.kind !== b.kind) return a.kind === 'generic' ? -1 : 1;
  const sd = strengthOrderKey(a.strength) - strengthOrderKey(b.strength);
  if (sd !== 0) return sd;
  return a.identifier.localeCompare(b.identifier);
}

function renderRelatedCard(card: RelatedCard): string {
  const covBadge =
    card.coverageKind === 'Covered'
      ? 'badge--covered'
      : card.coverageKind === 'Limited Use'
        ? 'badge--limited'
        : 'badge--not-covered';
  const title = `${card.displayIdentifier}${card.strength ? ' ' + card.strength.toLowerCase() : ''}`;
  // Show the dosage form and the collapse count together so the
  // collapsed-from-N-brands signal lands without a separate line.
  // Single-DIN cards drop the count — the URL gives precise info
  // when the user clicks through.
  const formChunk = card.dosageForm ? esc(card.dosageForm) : '';
  const countChunk =
    card.count > 1
      ? ` · ${card.count} ${card.kind === 'generic' ? 'generic alternatives' : 'brand-name DINs'}`
      : '';
  const formLine = formChunk || countChunk
    ? `<div class="related-card__form">${formChunk}${countChunk}</div>`
    : '';
  return `<a href="${BASE_PATH}/drug/${encodeURIComponent(card.representativeDin.id)}/" class="related-card">
  <div class="related-card__kind-row"><span class="badge badge--neutral">${card.kind === 'generic' ? 'Generic' : 'Brand'}</span></div>
  <div class="related-card__title">${esc(title)}</div>
  ${formLine}
  <div class="related-card__meta"><span class="badge ${covBadge}">${esc(card.coverageKind)}</span></div>
</a>`;
}

function renderRelatedDrugs(d: Drug, allDrugs: Drug[]): string {
  if (allDrugs.length === 0 || !d.genericGroupKey) return '';
  const allMatching = allDrugs.filter(
    (x) => x.genericGroupKey === d.genericGroupKey && x.id !== d.id,
  );
  if (allMatching.length === 0) return '';

  // Collapse each drug into a card keyed by
  // (kind, identifier, strength, dosageForm). Branded-generics (Apo-,
  // Teva-, …) collapse into one "generic" card per strength;
  // brand-name products each get their own card per strength.
  // Strength comes from `effectiveStrength(r)` which falls back to
  // extracting the strength token from `genericName` when parse.ts
  // left `drug.strength` null — see the helper's comment for why.
  const cards = new Map<string, RelatedCard>();
  for (const r of allMatching) {
    const cls = classifyRelated(r);
    const s = effectiveStrength(r);
    const strengthLc = (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const formLc = (r.dosageForm ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const key = `${cls.kind}|${cls.identifier}|${strengthLc}|${formLc}`;
    let card = cards.get(key);
    if (!card) {
      card = {
        kind: cls.kind,
        identifier: cls.identifier,
        displayIdentifier: cls.displayIdentifier,
        strength: s,
        dosageForm: r.dosageForm,
        dins: [],
        representativeDin: r,
        coverageKind: 'Not covered',
        count: 0,
      };
      cards.set(key, card);
    }
    card.dins.push(r);
  }
  for (const card of cards.values()) {
    card.coverageKind = coverageKindOf(card.dins);
    // Pass coverageKind so the click target represents the kind that
    // matches the badge — see pickRepresentativeDin for why.
    card.representativeDin = pickRepresentativeDin(card.dins, card.coverageKind);
    card.count = card.dins.length;
  }

  const cardsArr = [...cards.values()].sort(sortRelatedCards);
  const truncated = cardsArr.length > MAX_RELATED_DRUGS;
  const visibleCards = truncated ? cardsArr.slice(0, MAX_RELATED_DRUGS) : cardsArr;

  const cardsHtml = visibleCards.map(renderRelatedCard).join('\n');

  const suffix = truncated
    ? ` <span class="text-muted text-small">(showing ${visibleCards.length} of ${cardsArr.length})</span>`
    : '';

  return `<section class="detail__section">
  <h2 class="detail__section-title">Other drugs with the same generic name${suffix}</h2>
  <div class="related-list">
    ${cardsHtml}
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

/** Strip strength tokens + salt suffixes from a generic name string, so
 *  the result is the chemical generic alone (e.g.
 *  "METFORMIN HCL 500 MG TA" → "metformin hcl", used to decide whether
 *  the subtitle below the title is redundant once strength is folded
 *  into the title. Same token patterns as `pipeline/helpers.ts`. */
function genericStripped(generic: string): string {
  return generic
    // 1. drop strength tokens like "500 mg", "5 mg/mL", etc.
    .replace(
      /\b\d+(\.\d+)?\s*(mg|mcg|µg|g|ml|mL|iu|%|u|units?|mmol)\/?(kg|m\^?2)?\b/gi,
      '',
    )
    // 2. drop form-token suffixes — "TA", "TAB", "CAP", etc.
    .replace(/\b(TA|TAB|TABS|CAP|CAPS|ER|XR|SR|LA|CR|TABERGR24H|TBMP\s*24HR|TABLET|CAPSULE|TABLETS|CAPSULES)\b/gi, '')
    // 3. drop route words left over after the above
    .replace(/\b(TOPICAL|ORAL|INHALATION|INJECTION)\b/gi, '')
    // 4. collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function renderDrugPage(d: Drug, allDrugs: Drug[], meta: SiteMeta | null, base: string): string {
  // Title includes BOTH brand name AND strength when available, so a
  // user seeing the page reads "Metformin 500 mg" without having to
  // scan to the muted subtitle. Reference: drugsearch.ca listing rows
  // ("METFORMIN TAB 500MG"). Strength is normalised to lowercase so
  // PDDF-supplied "500 MG" renders as "500 mg" to match the
  // lowercase-only brand-name convention we use elsewhere.
  const displayName = d.brandName ?? d.genericName;
  const strengthSuffix = d.strength ? ` ${d.strength.toLowerCase()}` : '';
  const displayTitle = `${displayName}${strengthSuffix}`;
  const title = `${displayTitle} (DIN/PIN ${d.id})`;
  const escapeTitle = esc(title);
  const description =
    `Coverage, pricing, and Special Authority status for ${displayTitle} ` +
    `(DIN/PIN ${d.id}) across BC PharmaCare plans.`;
  const canonical = `${base}/drug/${encodeURIComponent(d.id)}/`;
  const cssHref = `${base}/${CSS_FILENAME}`;
  const faviconHref = `${base}/favicon.svg`;
  // Strip strength tokens out of the generic for the subtitle / redun-
  // dancy check. When (a) there is no brand name at all (true generic)
  // OR (b) the brand name already contains the cleaned generic text, the
  // subtitle would just restate the big-bold title and is suppressed.
  const cleanedGeneric = genericStripped(d.genericName).toLowerCase();
  const brandLc = (d.brandName ?? '').toLowerCase();
  const subtitleRedundant =
    !d.brandName ||
    brandLc === cleanedGeneric ||
    (cleanedGeneric.length >= 6 && brandLc.includes(cleanedGeneric));
  const genericLine = !subtitleRedundant
    ? `<p class="detail__generic">${esc(genericStripped(d.genericName))}</p>`
    : '';

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
      <h1 class="detail__title">${esc(displayTitle)}</h1>
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
