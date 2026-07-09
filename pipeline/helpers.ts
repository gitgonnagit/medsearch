/**
 * Pure helpers shared across pipeline stages. No I/O here.
 */

import type { PlanCoverage } from './types.js';

/** Salts/suffixes stripped when normalizing generic names for group keys. */
const SALT_SUFFIXES = [
  'hydrochloride',
  'hcl',
  'sulfate',
  'sulphate',
  'sodium',
  'potassium',
  'calcium',
  'magnesium',
  'mesylate',
  'maleate',
  'tartrate',
  'phosphate',
  'acetate',
  'fumarate',
  'succinate',
  'besylate',
  'citrate',
  'tromethamine',
  'besilate',
  'tosylate',
];

/** Strength token patterns (mg, mcg, %, etc.) used to strip strength from names. */
const STRENGTH_TOKEN = /\b\d+(\.\d+)?\s*(mg|mcg|µg|g|ml|mL|iu|%|u|units?|mmol)\/?(kg|m\^?2)?\b/gi;

/** Parse a BC PharmaCare date string ("MM/DD/YYYY" or ISO). Returns YYYY-MM-DD or null. */
export function parseDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Try MM/DD/YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, mo, d, y] = m;
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Try ISO
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

/** True if `endDate` (or null/open-ended) covers `asOf`. */
export function isActiveOn(effDate: string | null, endDate: string | null, asOf: Date): boolean {
  if (effDate && effDate > asOfIso(asOf)) return false;
  if (endDate && endDate < asOfIso(asOf)) return false;
  return true;
}

/** Format Date as YYYY-MM-DD. */
export function asOfIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Parse a numeric string into a number, returning null for empty/NaN. */
export function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Normalize a generic name into a group key. */
export function genericGroupKey(name: string, strength: string | null, dosageForm: string | null): string {
  let n = (name || '').toLowerCase();
  // strip strength tokens embedded in the name (e.g., "metformin 500 mg")
  n = n.replace(STRENGTH_TOKEN, '').replace(/\s+/g, ' ').trim();
  // strip salts at end of string: "metformin hydrochloride" -> "metformin"
  const tokens = n.split(/[\s,]+/).filter(Boolean);
  while (tokens.length > 0 && SALT_SUFFIXES.includes(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  const base = tokens.join(' ').trim();
  const formToken = (dosageForm || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const strengthToken = (strength || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return [base, formToken, strengthToken].filter(Boolean).join('|');
}

/** Light fuzzy normalization (lowercase, strip punctuation) for matching SA lists. */
export function normalizeForMatching(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/®|™|©|&reg;|&trade;|&copy;/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Y / N / blank → boolean. */
export function yn(v: unknown): boolean {
  const s = String(v ?? '').trim().toUpperCase();
  return s === 'Y';
}

/** True if `v` is null, undefined, or the number 0 — the BC PharmaCare
 *  PDDF source ships literal `0000.0000` for rdpPrice / lcaPrice / maxPrice
 *  to mean "no price", and `parseNum` returns the number `0` for that
 *  input rather than `null`. Without this pattern, code reading
 *  `displayPrice != null` happily accepts 0 as a real unit price and
 *  then the listing row's `Cheapest source plan` math downstream
 *  surfaces garbage ($0 * 90 = $0 / fill) that suppresses the row's
 *  price block. Same pattern already applied to `computeCostBreakdown`'s
 *  `unitsPerDayFor` — kept consistent across the layer. */
export function hasPositivePrice(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/** Coverage label and display price computation, given plan-level fields.
 *  All four price-source branches reject literal-zero PDDF values via
 *  `hasPositivePrice` — see the function above for why. Drugs whose
 *  rdpPrice / lcaPrice / maxPrice all recognise as "missing" end up
 *  with `Not covered` instead of a misleading `Covered, displayPrice=0`,
 *  which previously caused listings like metformin XR / ER to silently
 *  show "This drug is not covered" with no price block at all. */
export function derivePlanCoverage(input: {
  isLimitedUse: boolean;
  lcaInd: boolean;
  rdpCategory: string | null;
  rdpPrice: number | null;
  rdpExcludedPlans: string | null;
  plan: string;
  maxPrice: number | null;
  lcaPrice: number | null;
  planDescription: string | null;
}): { label: PlanCoverage['coverageLabel']; displayPrice: number | null } {
  // If special authority is required, mark Limited Use regardless of price.
  // Walk rdpPrice → maxPrice, treating literal 0 the same as missing so a
  // legacy row whose `maxPrice` field is `0004.0025` but whose RDP price
  // shipped as `0000.0000` falls through to the real maxPrice cleanly.
  if (input.isLimitedUse) {
    const price = hasPositivePrice(input.rdpPrice)
      ? input.rdpPrice
      : hasPositivePrice(input.maxPrice)
        ? input.maxPrice
        : null;
    return price == null
      ? { label: 'Not covered', displayPrice: null }
      : { label: 'Limited Use', displayPrice: price };
  }
  // If the drug is in an RDP category and this plan isn't excluded, RDP price applies.
  const isRdpExcludedFromThisPlan =
    !!input.rdpCategory &&
    !!input.rdpExcludedPlans &&
    input.rdpExcludedPlans
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .includes(input.plan.toUpperCase());
  if (
    !!input.rdpCategory &&
    hasPositivePrice(input.rdpPrice) &&
    !isRdpExcludedFromThisPlan
  ) {
    return { label: 'Covered', displayPrice: input.rdpPrice };
  }
  // LCA: lowest LCA price in category applies.
  if (input.lcaInd && hasPositivePrice(input.lcaPrice)) {
    return { label: 'Covered', displayPrice: input.lcaPrice };
  }
  if (hasPositivePrice(input.maxPrice)) {
    return { label: 'Covered', displayPrice: input.maxPrice };
  }
  return { label: 'Not covered', displayPrice: null };
}

/** Canonical dosage-form categories shown as filter chips on the search
 * home page. The labelled set is the user's editorial choice — the
 * pipeline maps the raw PDDF `Dosage Form` strings down to one of
 * these via `canonicalizeDosageForm`. */
export type CanonicalDosageForm =
  | 'oral solid'
  | 'oral liquid'
  | 'rectal'
  | 'injection'
  | 'topical'
  | 'inhaled'
  | 'nasal'
  | 'patch';

/** Display order for the chip strip on the home page. */
export const CANONICAL_DOSAGE_FORMS: readonly CanonicalDosageForm[] = [
  'oral solid',
  'oral liquid',
  'injection',
  'topical',
  'inhaled',
  'nasal',
  'patch',
  'rectal',
];

/**
 * Bucket a raw PDDF `Dosage Form` string (e.g. "Tablet", "Inhalation
 * Powder", "Ophthalmic Solution") into one of the canonical 8
 * categories. Returns null for forms that don't fit any chip — those
 * still render as raw text on the drug row UI but are not selectable
 * on the home filter strip.
 *
 * Substring matching, intentionally simple: unknown names fall through
 * to `null`. The mapping is conservative on combinations (e.g.
 * "transdermal patch" → `patch` rather than `topical`). Order matters:
 * `patch` is checked first so transdermal route doesn't fall into
 * topical; `injection` is checked before the oral-liquid route so
 * "Injection Solution" doesn't render as a drink.
 */
export function canonicalizeDosageForm(raw: string | null): CanonicalDosageForm | null {
  if (!raw) return null;
  const r = raw.toLowerCase();

  // `patch` first: transdermal is its own chip.
  if (/\bpatch(es)?\b|\btransdermal\b/.test(r)) return 'patch';

  // `injection` early: oral formulations sometimes include the word
  // "solution" / "suspension", and we want injectables claimed before
  // the oral-liquid route examines the same word.
  if (
    /\binjection\b|\binj\b|\biv\b|\bim\b|\bsc\b|\bsubcutaneous\b|\bparenteral\b|\bintravenous\b|\bintramuscular\b|\bprefilled\b|\bsyringe\b|\bvial\b|\bampul\b|\bampoule\b/.test(
      r,
    )
  ) {
    return 'injection';
  }

  // Inhaled
  if (/\binhal(er|ation)?\b|\bnebuli?zer\b|\baerosol\b/.test(r)) return 'inhaled';

  // Nasal
  if (/\bnasal\b/.test(r)) return 'nasal';

  // Rectal
  if (/\bsuppository\b|\benema\b|\brectal\b/.test(r)) return 'rectal';

  // Oral solid (tablet, capsule, chewable, lozenge, granule)
  if (
    /\btab(let|lets)?\b/.test(r) ||
    /\bcap(let|sule|lets|sules)?\b/.test(r) ||
    /\bchew(able)?\b/.test(r) ||
    /\blozenge\b/.test(r) ||
    /\bgranule\b/.test(r)
  ) {
    return 'oral solid';
  }

  // Oral liquid (solution / suspension / syrup / elixir / drops — but
  // only if not already claimed as injection above. Drops route to
  // oral liquid by default; the 8-chip set has no separate "eye/ear"
  // bucket, so eye drops / ear drops / otic drops without stronger
  // markers here would otherwise fall through to `null` and vanish
  // from filter chips. Injectable markers (`inj` / `iv` / `im` etc.)
  // are checked before this point, so injectable drops don't reach
  // here.)
  if (
    /\bsolution\b|\bsuspension\b|\bsyrup\b|\belixir\b|\bmixture\b|\bconcentrate\b|\bdrop[s]?\b/.test(r)
  ) {
    return 'oral liquid';
  }

  // Topical (cream, ointment, gel, lotion, wash, scalp, skin)
  if (
    /\bcream\b|\bointment\b|\bgel\b|\blotion\b|\bwash\b|\bscalp\b|\bskin\b|\btopical\b/.test(r)
  ) {
    return 'topical';
  }

  return null;
}

/** The Fair-PharmaCare plan code. FPC enrollees pay via the stepped
 *  deductible + 30% coinsurance + family-max structure rather than
 *  receiving the drug at $0 — so listing it under `fullyCoveredPlans`
 *  (where every other entry there is a $0 patient cost) would
 *  misrepresent FPC's coverage. Excluded from `fullyCoveredPlans` in
 *  `computePriceSummary` below. */
export const FAIR_PHARMACARE_PLAN = 'I';

/** Plan code "NP" historically covers a defined list of "no-cost" drugs
 *  (historically diabetes medications + a small set of others, per
 *  BC PharmaCare NP plan guidance). The PDDF-derived `coverageLabel`
 *  for NP rows may not match the model — some drugs ship with
 *  literal-zero displayPrice for plan NP, after the literal-zero fix
 *  those rows fall through to "Not covered" without ever surfacing
 *  the free-to-NP-enrollees fact. Force-included below for known
 *  diabetes-molecule generics; for any other category, NP behaves
 *  normally (it shows up in the plan table and is treated like
 *  every other plan). */
export const NP_PLAN = 'NP';

/** Lowercase substring patterns used to identify diabetes-molecule
 *  generic names for the NP force-include. Order is irrelevant —
 *  this is a `.includes` scan over the normalised genericName, not a
 *  precedence-ordered matcher. Add new molecules here if the
 *  business rule expands; conservative rather than exhaustive to
 *  avoid false-positive coverage claims. */
export const DIABETES_GENERIC_PATTERNS: readonly string[] = [
  // biguanides
  'metformin',
  // sulfonylureas
  'gliclazide', 'glipizide', 'glyburide', 'glimepiride', 'tolbutamide',
  // insulins + basal/bolus analogues
  'insulin', 'glargine', 'detemir', 'degludec', 'aspart', 'lispro', 'glutargine',
  // GLP-1 receptor agonists
  'semaglutide', 'liraglutide', 'dulaglutide', 'exenatide', 'lixisenatide',
  // DPP-4 inhibitors ("-gliptins")
  'sitagliptin', 'linagliptin', 'saxagliptin', 'alogliptin', 'vildagliptin',
  // SGLT2 inhibitors ("-flozins")
  'empagliflozin', 'dapagliflozin', 'canagliflozin', 'ertugliflozin',
  // thiazolidinediones + alpha-glucosidase inhibitors
  'rosiglitazone', 'pioglitazone', 'troglitazone',
  'acarbose', 'miglitol',
];

/** True if the supplied generic name (case-insensitive, after light
 *  normalisation) suggests a diabetes medication covered by plan NP.
 *  Returns false on null/empty input — that branch is meaningful for
 *  drugs missing a generic name entirely (PIN-classified products,
 *  research/study compounds, etc.). */
export function isDiabetesDrug(genericName: string | null | undefined): boolean {
  if (!genericName) return false;
  const n = genericName.toLowerCase();
  return DIABETES_GENERIC_PATTERNS.some((p) => n.includes(p));
}

/** Inline-listing-level price summary. Smaller than CostBreakdown —
 *  just enough for the per-row display on the search home page. All
 *  fields are nullable; when every plan has zero/null displayPrice
 *  the entire summary is replaced with `null` and the listing UI
 *  suppresses the price block. */
export interface PriceSummary {
  /** Reference fill quantity (units). Type-of-unit is `noun`. Derived
   *  from the cheapest plan's `maxDaysSupply × maxDailyQty` with
   *  fallbacks (90 days × 1 unit/day when source columns are null/0). */
  refFillUnits: number;
  /** Human noun for what a "unit" is — TABLETS for oral solid, PATCHES
   *  for transdermal, ACTUATIONS for inhaled, etc. Centralized here so
   *  frontend doesn't duplicate the form-to-noun mapping. Matches the
   *  convention used by drugsearch.ca's listing rows ("for 180 TABLETS"). */
  refFillNoun: string;
  /** Pre-fee, pre-share total cost: cheapest plan's unit price × refFillUnits. */
  totalCost: number;
  /** Post-deductible Fair-PharmaCare patient share (30% of total),
   *  matching the user's mental model of "70% / 30%" stepped plan. */
  patientCost: number;
  /** Same dollar amount as `patientCost`, surfaced under the listing
   *  row's "AFTER Deductible reached:" line. Kept redundant so the
   *  frontend doesn't have to translate "what patients pay after the
   *  FPC deductible" into prose in two different places. */
  patientShareAfterDeductible: number;
  /** Family-maximum stage of Fair-PharmaCare: once a family has paid
   *  up to its annual family maximum, PharmaCare covers 100% of
   *  eligible costs — patient share drops to $0.00 for the rest of
   *  the year. Constant 0 for now (we don't model per-drug copays
   *  or per-plan carve-outs). */
  familyMaxShare: number;
  /** PharmaCare plan codes where the drug is automatically fully
   *  covered at $0 patient cost (label=Covered, positive displayPrice,
   *  and NOT plan "I" Fair-PharmaCare). Limited Use plans (SA
   *  required) are also excluded since they don't auto-reimburse —
   *  the row falls back to "This drug is not covered" in that case. */
  fullyCoveredPlans: string[];
}

/** Default days-supply when the source `Max Days Supply` column is
 *  null or 0. 90 days is the most common BC PharmaCare dispensing cycle
 *  for maintenance drugs; matches the typical PDDF default for chronic
 *  oral solids. */
const DEFAULT_REFILL_DAYS = 90;

/** Map a drug's (dosage form, canonical bucket) → the noun shown next
 *  to the ref-fill count on the listing row ("180 TABLETS", "30 PATCHES").
 *  TABLETS is the dominant case; non-oral-solid forms get specific
 *  matches so users see e.g. PATCHES on a nicotine patch, ACTUATIONS
 *  on an inhaler (rather than a generic "DOSES" that obscures the unit
 *  the cost is calculated against). */
function refFillNounFor(
  _dosageForm: string | null,
  canonical: CanonicalDosageForm | null,
): string {
  switch (canonical) {
    case 'oral solid':
      return 'TABLETS';
    case 'patch':
      return 'PATCHES';
    case 'inhaled':
      return 'ACTUATIONS';
    case 'injection':
      return 'DOSES';
    case 'oral liquid':
      return 'DOSES';
    case 'topical':
      return 'APPLICATIONS';
    case 'nasal':
      return 'DOSES';
    case 'rectal':
      return 'DOSES';
    default:
      return 'DOSES';
  }
}

/**
 * Per-drug price summary for the search-result row. Precomputed at
 * pipeline time so the listing page renders with zero client-side cost
 * computation (the search results load 16K drugs client-side; running
 * filter+reduce on each render would be O(N) per keystroke).
 *
 * Inputs are the same primitive fields already aggregated into Drug
 * (plans, dosageForm, canonicalDosageForm, the cheapest plan's
 * maxDaysSupply, maxDailyQty). Math mirrors the detail page's
 * computeCostBreakdown where overlap exists, with one intentional
 * difference: this summary uses a per-fill reference (maxDaysSupply ×
 * maxDailyQty × unit price) rather than a per-day rate, because the
 * listing row is meant to communicate "what you'll actually pay at the
 * counter for one fill" — not the daily rate buried under the detail
 * page's monthly/3-month callout.
 *
 * Returns `null` when no plan has a positive displayPrice; the row
 * suppresses the price block and (separately) shows "not covered"
 * styling.
 */
export function computePriceSummary(
  plans: PlanCoverage[],
  dosageForm: string | null,
  canonical: CanonicalDosageForm | null,
  // Optional fourth arg: the drug's generic name. Used to apply
  // category-specific force-include rules below (e.g. NP plan for
  // diabetes drugs) when callers have it on hand. Default null keeps
  // the signature back-compat — callers that don't know the generic
  // (none today, but reserved for future tooling) just skip the
  // category rule without throwing.
  genericName: string | null = null,
): PriceSummary | null {
  const candidates = plans.filter(
    (p) => p.displayPrice != null && p.displayPrice > 0,
  );
  if (candidates.length === 0) return null;

  // Cheapest plan drives both the unit price AND the fill quantity, so
  // the row's dollar figure is internally consistent ("what ONE fill at
  // the cheapest plan costs"). Picking a different plan's maxDaysSupply
  // would silently misrepresent the patient's actual prescription.
  // Same literal-0 handling as computeCostBreakdown: PDDF sometimes
  // ships 0 where it means "no cap"; `??` wouldn't catch that.
  const cheapest = candidates.reduce((a, b) =>
    a.displayPrice! <= b.displayPrice! ? a : b,
  );
  const days = cheapest.maxDaysSupply != null && cheapest.maxDaysSupply > 0
    ? cheapest.maxDaysSupply
    : DEFAULT_REFILL_DAYS;
  const perDay = cheapest.maxDailyQty != null && cheapest.maxDailyQty > 0
    ? cheapest.maxDailyQty
    : 1;
  const refFillUnits = days * perDay;
  const unitPrice = cheapest.displayPrice!;
  const totalCost = unitPrice * refFillUnits;
  const patientCost = totalCost * PATIENT_SHARE;

  // Listing-level coverage distinction: a drug can have a positive
  // displayPrice via the cheapest plan (used for the FPC math above)
  // yet have ZERO plans where enrollees pay $0. The "FULLY COVERED
  // for plans X,Y" line on the reference site is for the second
  // category only — B/C/F/W/etc. enrollees. FPC enrollees (plan I)
  // go through the deductible / 30% / family-max structure spelled
  // out below the row instead. Limited Use plans (SA-required) are
  // also excluded — they don't auto-reimburse.
  // Standard fully-covered filter: positive price, status Covered,
  // NOT the Fair-PharmaCare plan (FPC is stepped, not $0). NP plan
  // flows through the standard filter unchanged — when PDDF carries
  // a positive displayPrice for NP on a non-diabetes drug, that's
  // a legitimate fully-covered claim and we'd underreport if we
  // excluded it. The diabetes-specific force-include below handles
  // only the literal-zero / non-Covered cases where the standard
  // filter would still drop NP.
  const fullyCoveredPlans = plans
    .filter(
      (p) =>
        p.coverageLabel === 'Covered' &&
        hasPositivePrice(p.displayPrice) &&
        p.plan !== FAIR_PHARMACARE_PLAN,
    )
    .map((p) => p.plan);

  // BC PharmaCare NP plan (No-cost for specific categories): per the
  // user's reference, NP covers 100% of diabetes medications. PDDF
  // rows for "NP" on diabetes drugs sometimes ship with literal-zero
  // `displayPrice` (so they fail `hasPositivePrice`), so the literal-
  // zero guard above correctly drops them — but bypassing that for NP
  // when the drug is a diabetes molecule is the user's intent here.
  // Post-process only fires when (a) the drug is a diabetes molecule,
  // (b) the drug has an NP plan row, and (c) NP didn't already flow
  // through the standard filter. Conditional inclusion keeps non-
  // diabetes drugs' fullyCoveredPlans untouched.
  if (
    genericName &&
    isDiabetesDrug(genericName) &&
    plans.some((p) => p.plan === NP_PLAN) &&
    !fullyCoveredPlans.includes(NP_PLAN)
  ) {
    fullyCoveredPlans.push(NP_PLAN);
  }
  fullyCoveredPlans.sort();

  return {
    refFillUnits,
    refFillNoun: refFillNounFor(dosageForm, canonical),
    totalCost,
    patientCost,
    patientShareAfterDeductible: patientCost,
    familyMaxShare: 0,
    fullyCoveredPlans,
  };
}

/** Result of evaluating per-plan costs for one drug and picking the
 *  cheapest daily cost. Used by the detail page's "Patient Pays" callout. */
export interface CostBreakdown {
  /** Cheapest source plan (smallest `displayPrice × unitsPerDay`,
   *  using PlanCoverage.displayPrice so RDP- and LCA-adjusted
   *  reimbursement costs surface correctly on Limited Use drugs whose
   *  raw `maxPrice` is null). The field is named `unitPrice` to avoid
   *  the spec's literal "maxPrice" wording tripping future readers
   *  into thinking it bypasses RDP/LCA adjustments. */
  source: {
    plan: string;
    unitPrice: number;
    unitsPerDay: number;
    costPerDay: number;
  } | null;
  /** Pre-fee, pre-share full monthly + 3-month totals (used as the
   *  reference context under the patient share callout). */
  fullMonthly: number | null;
  fullThreeMonth: number | null;
  /** Patient share after the deductible (30% of full, matching the
   *  user's mental model of "70% / 30%" Fair-PharmaCare stepped plan). */
  patientMonthly: number | null;
  patientThreeMonth: number | null;
  /** Disclosure string for unit-dose routes (1 vial/day, 1 patch/day)
   *  so users see the unit-shape rather than a 30× implication. */
  unitDisclosure: string | null;
}

const DISPENSING_FEE = 11.0;
const PATIENT_SHARE = 0.30;

/** Default units-per-day assumption when the source `Max Daily Qty`
 *  column is missing. 1/day is the canonical schedule for tablets,
 *  capsules, and most oral solids on BC PharmaCare schedules; combined
 *  with `unitDisclosure` (which only fires when raw data says 1 AND
 *  the form is unit-dose), this is conservative when the column is
 *  absent (it never overstates cost) and corrected upward when the
 *  raw value is higher. */
const DEFAULT_UNITS_PER_DAY = 1;

/**
 * Returns the cheapest daily cost across the drug's active plans and
 * computes 30/90-day patient-share totals using a flat 30% post-
 * deductible rate (matching the user's mental model of "70% / 30%").
 *
 * Uses `PlanCoverage.displayPrice` (not raw `maxPrice`) because
 * `displayPrice` is the post-RDP/LCA-adjusted reimbursement price
 * already shown in the user's coverage table. Limited Use drugs whose
 * raw `maxPrice` is null have a non-null `displayPrice` (from the
 * RDP/LCA reference price via `derivePlanCoverage`), so using
 * `displayPrice` is what makes the callout render for SA / RDP drugs
 * rather than blankly disappearing on them.
 *
 * Filter: a plan is a candidate iff `displayPrice` is positive. We
 * do NOT require `maxDailyQty` to be set — when it's null or 0 we use
 * `DEFAULT_UNITS_PER_DAY` (1) per the comment above. Returns
 * `source: null` only when no plan has a usable displayed price, so
 * the callout still skips in the (rare) case where every plan's
 * price was null after RDP/LCA adjustment.
 *
 * `unitDisclosure` fires only when the raw `maxDailyQty === 1` AND
 * the form matches a unit-dose route — i.e. when the source
 * explicitly confirms it's unit-dose, not when the fallback guessed
 * 1. For per-tablet or per-capsule schedules it's also suppressed,
 * because "1 tablet/day" isn't surprising on its own and would just
 * be clutter on the dominant oral-solid case.
 */
export function computeCostBreakdown(
  plans: PlanCoverage[],
  dosageForm: string | null,
): CostBreakdown {
  const candidates = plans.filter(
    (p) => p.displayPrice != null && p.displayPrice > 0,
  );
  if (candidates.length === 0) {
    return {
      source: null,
      fullMonthly: null,
      fullThreeMonth: null,
      patientMonthly: null,
      patientThreeMonth: null,
      unitDisclosure: null,
    };
  }
  // Pick smallest costPerDay (= displayPrice × unitsPerDay) across
  // plans. `unitsPerDayFor(p)` is the raw qty when positive, otherwise
  // the DEFAULT_UNITS_PER_DAY fallback. We treat literal 0 the same as
  // missing/null: PDDF rows where the source listed "no daily cap"
  // sometimes ship as `0` rather than blank, and `??` would silently
  // surface that as a real budget.
  const unitsPerDayFor = (p: PlanCoverage): number =>
    p.maxDailyQty != null && p.maxDailyQty > 0 ? p.maxDailyQty : DEFAULT_UNITS_PER_DAY;
  const cheapest = candidates.reduce((a, b) =>
    a.displayPrice! * unitsPerDayFor(a) <= b.displayPrice! * unitsPerDayFor(b) ? a : b,
  );
  const unitsPerDay = unitsPerDayFor(cheapest);
  const costPerDay = cheapest.displayPrice! * unitsPerDay;
  const fullMonthly = costPerDay * 30 + DISPENSING_FEE;
  const fullThreeMonth = costPerDay * 90 + DISPENSING_FEE;
  const patientMonthly = fullMonthly * PATIENT_SHARE;
  const patientThreeMonth = fullThreeMonth * PATIENT_SHARE;

  const form = (dosageForm ?? '').toLowerCase();
  // Only disclose unit-dose when the source explicitly confirms
  // raw maxDailyQty === 1. The fallback (maxDailyQty = null) would
  // mistakenly surface "1 unit" claims on drugs whose schedule is
  // actually multi-dose, so we gate on the raw value, not on the
  // post-fallback `unitsPerDay` we feed into the math.
  const isUnitDoseForm =
    cheapest.maxDailyQty === 1 &&
    /\b(injection|solution|suspension|syrup|elixir|patch|inhaler|spray|vial|ampul|ampoule|nebulizer|drop|sachet|enema)\b/.test(
      form,
    );
  const unitDisclosure = isUnitDoseForm
    ? `Cost based on max daily quantity of 1 unit (${form.trim()}).`
    : null;

  return {
    source: {
      plan: cheapest.plan,
      unitPrice: cheapest.displayPrice!,
      unitsPerDay,
      costPerDay,
    },
    fullMonthly,
    fullThreeMonth,
    patientMonthly,
    patientThreeMonth,
    unitDisclosure,
  };
}
