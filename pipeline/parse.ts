/**
 * PDDF CSV parser: reads each row, filters to currently-active records, and
 * aggregates by DIN/PIN into one `Drug` per id.
 *
 * Streaming with csv-parse keeps peak memory well under 500MB for ~300k rows
 * even on GitHub Actions free runners.
 */

import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import type { Drug, PlanCoverage } from './types.js';
import {
  asOfIso,
  canonicalizeDosageForm,
  derivePlanCoverage,
  genericGroupKey,
  isActiveOn,
  parseDate,
  parseNum,
  yn,
} from './helpers.js';

/** Per-DIN aggregator state. */
interface Bucket {
  id: string;
  idKind: 'din' | 'pin';
  /** Rows keyed by effDate (latest wins as primary). */
  rows: RawRow[];
  plans: Map<string, RawRow>; // plan → best row for this plan
  isLimitedUse: boolean;
  brandNamesSeen: Set<string>;
}

interface RawRow {
  plan: string;
  effDate: string | null;
  endDate: string | null;
  benefitGroup: string | null;
  lcaInd: boolean;
  payGenInd: boolean;
  brandName: string | null;
  manufacturer: string | null;
  genericName: string;
  dosageForm: string | null;
  strength: string | null;
  trialFlg: boolean;
  maxPrice: number | null;
  lcaPrice: number | null;
  rdpCategory: string | null;
  rdpSubCategory: string | null;
  rdpPrice: number | null;
  rdpExcludedPlans: string | null;
  canFedRegCd: string | null;
  planDescription: string | null;
  maxDaysSupply: number | null;
  maxDailyQty: number | null;
  qtyLimit: string | null;
  formularyListDate: string | null;
  ltdUseFlag: boolean;
}

function rowFromRecord(rec: Record<string, unknown>): RawRow | null {
  const id = String(rec['DIN/PIN'] ?? '').trim();
  if (!id) return null;
  const plan = String(rec['Plan'] ?? '').trim();
  if (!plan) return null;
  return {
    plan,
    effDate: parseDate(rec['Rec Eff Date']),
    endDate: parseDate(rec['Rec End Date']),
    benefitGroup: String(rec['Ben Grp List'] ?? '').trim() || null,
    lcaInd: yn(rec['LCA Ind']),
    payGenInd: yn(rec['Pay Gen Ind']),
    brandName: String(rec['Brand Nm'] ?? '').trim() || null,
    manufacturer: String(rec['Manuf'] ?? '').trim() || null,
    genericName: String(rec['Generic Nm'] ?? '').trim(),
    dosageForm: String(rec['Dosage Form'] ?? '').trim() || null,
    // Strength is not exposed as a dedicated column in the BC PharmaCare PDDF;
    // the source combines brand/generic name and strength in the same string
    // (e.g., "Lipitor 20 mg"). We deliberately do not attempt regex extraction
    // here so we never mis-split a name. Documented as a known limitation in
    // the README; downstream `genericGroupKey` therefore groups all dose
    // variants of the same generic together as "interchangeables."
    strength: null,
    trialFlg: yn(rec['Trial Flg']),
    maxPrice: parseNum(rec['Max Price']),
    lcaPrice: parseNum(rec['LCA Price']),
    rdpCategory: String(rec['RDP Cat'] ?? '').trim() || null,
    rdpSubCategory: String(rec['RDP Sub Cat'] ?? '').trim() || null,
    rdpPrice: parseNum(rec['RDP Price']),
    rdpExcludedPlans: String(rec['RDP Excl Plans'] ?? '').trim() || null,
    canFedRegCd: String(rec['Can Fed Reg Cd'] ?? '').trim() || null,
    planDescription: String(rec['Pcare Plan Desc'] ?? '').trim() || null,
    maxDaysSupply: parseNum(rec['Max Days Supply']),
    maxDailyQty: parseNum(rec['Max Daily Qty']),
    qtyLimit: String(rec['Qty Limit'] ?? '').trim() || null,
    formularyListDate: parseDate(rec['Formulary List Date']),
    ltdUseFlag: yn(rec['Ltd Use Flag']),
  };
}

/** Stream CSV → Map<id, Bucket> of currently-active rows. */
export async function streamActiveBuckets(csvPath: string, asOf: Date): Promise<Map<string, Bucket>> {
  const buckets = new Map<string, Bucket>();
  // csv-parse 5.x: `columns: true` uses the first row as headers. Cast to
  // `any` here because the option's union type (boolean | string[] | function)
  // does not list `true` literal cleanly in all @types/csv-parse versions.
  const parser = createReadStream(csvPath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quoted_numeric: true,
      bom: true,
      trim: true,
    } as any),
  );

  for await (const rec of parser as AsyncIterable<Record<string, unknown>>) {
    const row = rowFromRecord(rec);
    if (!row) continue;
    if (!isActiveOn(row.effDate, row.endDate, asOf)) continue;
    const rawId = String(rec['DIN/PIN']).trim();
    let bucket = buckets.get(rawId);
    if (!bucket) {
      bucket = {
        id: rawId,
        idKind: /^\d/.test(rawId) ? 'din' : 'pin',
        rows: [],
        plans: new Map(),
        isLimitedUse: false,
        brandNamesSeen: new Set(),
      };
      buckets.set(rawId, bucket);
    }
    bucket.rows.push(row);
    if (row.ltdUseFlag) bucket.isLimitedUse = true;
    if (row.brandName) bucket.brandNamesSeen.add(row.brandName);
    // For each plan, keep the latest-effective row.
    const existing = bucket.plans.get(row.plan);
    if (!existing || (row.effDate ?? '') > (existing.effDate ?? '')) {
      bucket.plans.set(row.plan, row);
    }
  }
  // Summary logging only (no error semantics, just diagnostic).
  return buckets;
}

/** Convert buckets → array of Drug records ready for enrichment. */
export function bucketsToDrugs(buckets: Map<string, Bucket>): Drug[] {
  const drugs: Drug[] = [];
  for (const b of buckets.values()) {
    // Pick primary row: most-recent effective date among active rows.
    const sorted = [...b.rows].sort((a, c) => (a.effDate ?? '').localeCompare(c.effDate ?? ''));
    const primary = sorted[sorted.length - 1] ?? b.rows[0];

    const plans: PlanCoverage[] = [];
    const seenPlans = new Set<string>();
    for (const row of b.plans.values()) {
      seenPlans.add(row.plan);
      const derived = derivePlanCoverage({
        isLimitedUse: b.isLimitedUse,
        lcaInd: row.lcaInd,
        rdpCategory: row.rdpCategory,
        rdpPrice: row.rdpPrice,
        rdpExcludedPlans: row.rdpExcludedPlans,
        plan: row.plan,
        maxPrice: row.maxPrice,
        lcaPrice: row.lcaPrice,
        planDescription: row.planDescription,
      });
      plans.push({
        plan: row.plan,
        planDescription: row.planDescription,
        maxPrice: row.maxPrice,
        lcaPrice: row.lcaPrice,
        rdpCategory: row.rdpCategory,
        rdpSubCategory: row.rdpSubCategory,
        rdpPrice: row.rdpPrice,
        rdpExcludedPlans: row.rdpExcludedPlans,
        maxDaysSupply: row.maxDaysSupply,
        maxDailyQty: row.maxDailyQty,
        qtyLimit: row.qtyLimit,
        formularyListDate: row.formularyListDate,
        trialFlg: row.trialFlg,
        payGenInd: row.payGenInd,
        lcaInd: row.lcaInd,
        coverageLabel: derived.label,
        displayPrice: derived.displayPrice,
      });
    }
    plans.sort((a, c) => a.plan.localeCompare(c.plan));

    const latestEndDate = sorted[0]?.endDate ?? null;
    drugs.push({
      id: b.id,
      idKind: b.idKind,
      brandName: primary?.brandName ?? null,
      genericName: primary?.genericName ?? '',
      manufacturer: primary?.manufacturer ?? null,
      dosageForm: primary?.dosageForm ?? null,
      strength: primary?.strength ?? null,
      benefitGroup: primary?.benefitGroup ?? null,
      latestEffDate: primary?.effDate ?? null,
      latestEndDate,
      isLimitedUse: b.isLimitedUse,
      saLink: null,
      saDirectoryLink: 'https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/programs/special-authority/sa-drug-list',
      healthCanadaDpdUrl: `https://health-products.canada.ca/dpd-bdpp/dispatch-repartition?lang=en&din=${encodeURIComponent(b.id)}`,
      plans,
      allKnownPlanCodes: [...seenPlans].sort(),
      relatedDins: [], // populated in enrich stage
      genericGroupKey: genericGroupKey(
        primary?.genericName ?? '',
        primary?.strength ?? null,
        primary?.dosageForm ?? null,
      ),
      inLcaCategory: plans.some((p) => p.lcaInd),
      lcaCategory: null,
      inRdpCategory: plans.some((p) => p.rdpCategory != null),
      rdpCategory: null,
      hasGenericEquivalents: b.brandNamesSeen.size > 1,
      canonicalDosageForm: canonicalizeDosageForm(primary?.dosageForm ?? null),
    });
  }
  drugs.sort((a, c) => a.genericName.localeCompare(c.genericName));
  return drugs;
}
