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
const STRENGTH_TOKEN = /\b\d+(\.\d+)?\s*(mg|mcg|µg|g|ml|mL|iu|%|u|units?|mmol)\/?(kg|m[\^]?2)?\b/gi;

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

/** Coverage label and display price computation, given plan-level fields. */
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
  if (input.isLimitedUse) {
    const price = input.rdpPrice ?? input.maxPrice ?? null;
    return { label: 'Limited Use', displayPrice: price };
  }
  // If the drug is in an RDP category and this plan isn't excluded, RDP price applies.
  const isRdpExcludedFromThisPlan =
    !!input.rdpCategory &&
    !!input.rdpExcludedPlans &&
    input.rdpExcludedPlans
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .includes(input.plan.toUpperCase());
  if (input.rdpCategory && input.rdpPrice != null && !isRdpExcludedFromThisPlan) {
    return { label: 'Covered', displayPrice: input.rdpPrice };
  }
  // LCA: lowest LCA price in category applies.
  if (input.lcaInd && input.lcaPrice != null) {
    return { label: 'Covered', displayPrice: input.lcaPrice };
  }
  if (input.maxPrice != null) {
    return { label: 'Covered', displayPrice: input.maxPrice };
  }
  return { label: 'Not covered', displayPrice: null };
}
