/**
 * LCA/RDP enrichment.
 *
 * The PDDF already carries LCA Price and RDP pricing on each per-plan row.
 * The standalone LCA / RDP xlsx files add cross-references between drugs in
 * the same pricing category, so the user can see "other drugs in this LCA
 * category" alongside their selected drug.
 *
 * Both xlsx files contain DIN columns; we match on those directly.
 *
 * Column names observed in the live xlsx files (after `range: 1`):
 *   LCA: `DIN`, `Chemical Name`, `Drug Name`, `MAN`,
 *        `Full / Partial LCA Benefit`, `RDP`, `Tiered Pricing Categories`,
 *        `Max Price`, `LCA Price`, ...
 *   RDP: `RDP Category`, `DIN`, `Generic Name`, `Drug Name`, `MAN`, `RDP`, ...
 */

import type { Drug } from './types.js';

export interface LcaRdpEnrichment {
  /** Map from DIN/PIN to its LCA category name (optional). */
  lcaCategoryByDrugId: Map<string, string>;
  /** Map from LCA category name to DIN/PINs in that category. */
  drugsInLcaCategory: Map<string, string[]>;
  /** Map from DIN/PIN to its RDP category name. */
  rdpCategoryByDrugId: Map<string, string>;
  /** Map from RDP category name to DIN/PINs in that category. */
  drugsInRdpCategory: Map<string, string[]>;
}

/** Pick the first existing key from a list of candidates. */
function pick(row: Record<string, unknown>, candidates: string[]): string | null {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export function buildLcaRdpEnrichment(
  lcaRows: Record<string, unknown>[],
  rdpRows: Record<string, unknown>[],
): LcaRdpEnrichment {
  const lcaCategoryByDrugId = new Map<string, string>();
  const drugsInLcaCategory = new Map<string, string[]>();
  const rdpCategoryByDrugId = new Map<string, string>();
  const drugsInRdpCategory = new Map<string, string[]>();

  // LCA file
  if (lcaRows.length > 0) {
    const idCol = pick(lcaRows[0], ['DIN', 'DIN/PIN', 'PIN']);
    // For LCA, the category name appears in "Tiered Pricing Categories".
    const catCol = pick(lcaRows[0], [
      'Tiered Pricing Categories',
      'LCA Category',
      'LCA Category Name',
      'Category',
    ]);

    if (idCol && catCol) {
      for (const row of lcaRows) {
        const raw = row[idCol];
        const cat = String(row[catCol] ?? '').trim();
        if (raw == null || !cat) continue;
        const id = String(raw).trim();
        if (!id) continue;
        lcaCategoryByDrugId.set(id, cat);
        const list = drugsInLcaCategory.get(cat) ?? [];
        list.push(id);
        drugsInLcaCategory.set(cat, list);
      }
    }
  }

  // RDP file
  if (rdpRows.length > 0) {
    const idCol = pick(rdpRows[0], ['DIN', 'DIN/PIN', 'PIN']);
    const catCol = pick(rdpRows[0], ['RDP Category', 'Category', 'RDP Group', 'Group']);

    if (idCol && catCol) {
      for (const row of rdpRows) {
        const raw = row[idCol];
        const cat = String(row[catCol] ?? '').trim();
        if (raw == null || !cat) continue;
        const id = String(raw).trim();
        if (!id) continue;
        rdpCategoryByDrugId.set(id, cat);
        const list = drugsInRdpCategory.get(cat) ?? [];
        list.push(id);
        drugsInRdpCategory.set(cat, list);
      }
    }
  }

  return { lcaCategoryByDrugId, drugsInLcaCategory, rdpCategoryByDrugId, drugsInRdpCategory };
}

/** Apply LCA/RDP enrichment to the Drug array (returns a new array). */
export function applyLcaRdpEnrichment(drugs: Drug[], lcaRdp: LcaRdpEnrichment): Drug[] {
  return drugs.map((d) => {
    const lcaCat = lcaRdp.lcaCategoryByDrugId.get(d.id) ?? null;
    const rdpCat = lcaRdp.rdpCategoryByDrugId.get(d.id) ?? null;
    return {
      ...d,
      inLcaCategory: d.inLcaCategory || lcaCat != null,
      lcaCategory: lcaCat,
      inRdpCategory: d.inRdpCategory || rdpCat != null,
      rdpCategory: rdpCat,
    };
  });
}
