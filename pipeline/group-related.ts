/**
 * Group drugs by `genericGroupKey` and populate `relatedDins`.
 *
 * A drug's `relatedDins` are drugs that share the same normalized generic name,
 * dosage form, and strength — i.e., the typical interchangeables list.
 */

import type { Drug } from './types.js';

/** Update each drug's `relatedDins` field in a new array. */
export function attachRelatedDins(drugs: Drug[]): Drug[] {
  const groups = new Map<string, string[]>();
  for (const d of drugs) {
    const arr = groups.get(d.genericGroupKey);
    if (arr) arr.push(d.id);
    else groups.set(d.genericGroupKey, [d.id]);
  }
  return drugs.map((d) => ({
    ...d,
    relatedDins: (groups.get(d.genericGroupKey) ?? []).filter((x) => x !== d.id),
  }));
}
