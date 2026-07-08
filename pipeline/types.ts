import type { CanonicalDosageForm } from './helpers.js';

/**
 * Shared types between the data pipeline and the frontend.
 *
 * The pipeline emits `Drug` objects (one per active DIN/PIN), and the
 * Next.js build consumes them via `generateStaticParams` and props.
 * Match these types exactly between pipeline output and frontend imports.
 */

/** A drug identifier is either a DIN (Drug Identification Number, digits) or
 * a PIN (Product Identification Number, supplements/devices, letters+digits). */
export type IdKind = 'din' | 'pin';

/** Single plan-level coverage row for one drug in one PharmaCare plan. */
export interface PlanCoverage {
  /** The plan code, e.g. "B", "C", "F", "I", "P", "W", "G". */
  plan: string;
  /** Human-readable plan description, e.g. "Fair PharmaCare Plan". */
  planDescription: string | null;
  /** Maximum PharmaCare-recognized price for this drug in this plan. */
  maxPrice: number | null;
  /** Low Cost Alternative price (only set when LCA Ind = Y). */
  lcaPrice: number | null;
  /** Reference Drug Program category name (e.g. "Statin Drugs"). */
  rdpCategory: string | null;
  /** RDP sub-category, if any. */
  rdpSubCategory: string | null;
  /** RDP recognized reference price for this drug in this plan. */
  rdpPrice: number | null;
  /** Plans excluded from RDP pricing for this drug (often the plan itself). */
  rdpExcludedPlans: string | null;
  /** Maximum days supply allowed in this plan. */
  maxDaysSupply: number | null;
  /** Per-dispenser quantity limit (Free-form text in source; preserve as-given). */
  qtyLimit: string | null;
  /** Formula listing date for this plan (ISO `YYYY-MM-DD` or null). */
  formularyListDate: string | null;
  /** Trial Prescription program flag (Y/N). */
  trialFlg: boolean;
  /** Pay-generic indicator (Y/N) — affects patient pricing when generic present. */
  payGenInd: boolean;
  /** LCA indicator (Y/N) — drug is part of an LCA category. */
  lcaInd: boolean;
  /** Computed status label for UI: "Covered" | "Limited Use" | "Not covered". */
  coverageLabel: 'Covered' | 'Limited Use' | 'Not covered';
  /** Computed maximum recognized reimbursement for this plan (null if not covered). */
  displayPrice: number | null;
}

/** A drug as it appears in the processed dataset (one entry per DIN/PIN). */
export interface Drug {
  /** The DIN or PIN, preserved as the source provided it. */
  id: string;
  /** DIN vs PIN classification. PIN starts with a non-digit. */
  idKind: IdKind;
  /** Brand name as listed in the source. May be null for true generics. */
  brandName: string | null;
  /** Generic (molecule) name. Always present. */
  genericName: string;
  /** Manufacturer. */
  manufacturer: string | null;
  /** Dosage form / route (e.g. "Tablet", "Inhaled Powder", "Injection"). */
  dosageForm: string | null;
  /** Strength description (e.g. "20 mg", "5 mg/mL"). */
  strength: string | null;
  /** Primary benefit group (A, B, C, ..., LC = Special Authority, etc.). */
  benefitGroup: string | null;
  /** Latest effective date for this drug record (ISO `YYYY-MM-DD`). */
  latestEffDate: string | null;
  /** Most recent end date observed across all rows (null if any are open-ended). */
  latestEndDate: string | null;
  /** Whether Special Authority is required (Ltd Use Flag = Y in any plan). */
  isLimitedUse: boolean;
  /** Direct link to SA criteria/form for this drug (best-effort match). */
  saLink: string | null;
  /** Fallback SA directory link when no confident match was found. */
  saDirectoryLink: string;
  /** Link to the drug's monograph on Health Canada's DPD. */
  healthCanadaDpdUrl: string;
  /** Active per-plan coverage entries. */
  plans: PlanCoverage[];
  /** Plan descriptions referenced but not in coverage entries (helps UI). */
  allKnownPlanCodes: string[];
  /** DINs of other drugs in the same generic-strength-dosage group. */
  relatedDins: string[];
  /** Stable normalized group key (used for client-side grouping lookups). */
  genericGroupKey: string;
  /** Bucket category for the raw `dosageForm`; one of the canonical 8 chips
   * (e.g. "oral solid", "topical") or null if the raw form didn't bucket. */
  canonicalDosageForm: CanonicalDosageForm | null;
  /** True if this drug is part of an LCA category in the source. */
  inLcaCategory: boolean;
  /** LCA category name, if any. */
  lcaCategory: string | null;
  /** True if this drug is part of an RDP category in the source. */
  inRdpCategory: boolean;
  /** RDP category name, if any. */
  rdpCategory: string | null;
  /** Whether this drug's brand name is unique (false if multiple DINs share the brand). */
  hasGenericEquivalents: boolean;
}

/** Compact drug projection shipping to the browser for search-result rendering. */
export interface SearchCompanionRow {
  id: string;
  brandName: string | null;
  genericName: string;
  /** Raw `dosageForm` string from PDDF — kept for display on the result row. */
  dosageForm: string | null;
  /** Bucket category matching the chip strip on the home page. */
  canonicalDosageForm: CanonicalDosageForm | null;
  manufacturer: string | null;
  isLimitedUse: boolean;
  inLcaCategory: boolean;
  inRdpCategory: boolean;
}

/** Site metadata emitted with each pipeline run. */
export interface SiteMeta {
  generatedAt: string;
  asOfDate: string;
  drugCount: number;
  source: {
    pddfUrl: string;
    fetchedAt: string;
  };
  schemaVersion: number;
}

/** Source field order as confirmed against the live BC PharmaCare CSV. */
export const PDDF_COLUMNS = [
  'DIN/PIN',
  'Plan',
  'Rec Eff Date',
  'Rec End Date',
  'Ben Grp List',
  'LCA Ind',
  'Pay Gen Ind',
  'Brand Nm',
  'Manuf',
  'Generic Nm',
  'Dosage Form',
  'Trial Flg',
  'Max Price',
  'LCA Price',
  'RDP Cat',
  'RDP Sub Cat',
  'RDP Price',
  'RDP Excl Plans',
  'Can Fed Reg Cd',
  'Pcare Plan Desc',
  'Max Days Supply',
  'Qty Limit',
  'Formulary List Date',
  'Ltd Use Flag',
  'Max Daily Qty',
  'Max Period Qty',
  'Max Period Qty Days',
  'Max Annual Qty',
  'BGTS Cat Cd',
  'BGTS Cat Desc',
  'BGTS Max Annual Qty',
] as const;
