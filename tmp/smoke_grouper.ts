// tmp/smoke_grouper.ts — verifies the related-drugs grouping after:
//   1. cleanedMoleculeName strips form tokens (TA, TAB, CAP, ...)
//   2. effectiveStrength() extracts strength from genericName when
//      parse.ts left drug.strength null
//   3. effectiveStrength now also handles "10 mg/ml" liquid conc.
//      (the trailing /(?:ml|mL|ML|kg|m^2)? stays inside the capture
//      so liquid-concentration cards don't render with a bare "/" tail)

import { readFileSync } from 'node:fs';
import { cleanedMoleculeName } from '../pipeline/helpers.js';

interface RawDrug {
  id: string;
  brandName: string | null;
  genericName: string;
  dosageForm: string | null;
  strength: string | null;
  genericGroupKey: string;
}

const drugs = JSON.parse(
  readFileSync('./data-cache/drugs.json', 'utf8'),
) as RawDrug[];

const target = drugs.find((d) => d.id === '02397862');
if (!target) {
  console.log('FATAL: DIN 02397862 not in drugs.json');
  process.exit(1);
}

const matching = drugs.filter(
  (d) => d.genericGroupKey === target.genericGroupKey && d.id !== '02397862',
);
console.log(`Target ${target.id} (Accel-Atorvastatin 10 Mg Tab) bucket: ${matching.length} DINs`);

// Mirror emit-static.ts: classifyRelated + effectiveStrength + dedup key.
function effectiveStrength(d: RawDrug): string | null {
  if (d.strength) return d.strength;
  const m = /\b(\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|mL|iu|%|u|units?|mmol)(?:\/(?:ml|mL|ML|kg|m\^?2))?)\b/i.exec(d.genericName);
  if (!m) return null;
  return m[1].trim().toLowerCase().replace(/\s+/g, ' ');
}

function classifyRelated(d: RawDrug): { kind: 'generic' | 'brand'; identifier: string } {
  const baseLc = cleanedMoleculeName(d.genericName);
  const brandLc = (d.brandName ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const brandedGeneric =
    !!brandLc &&
    (brandLc === baseLc || (baseLc.length >= 6 && brandLc.includes(baseLc)));
  if (!brandLc || brandedGeneric) return { kind: 'generic', identifier: baseLc };
  return { kind: 'brand', identifier: brandLc };
}

// Spot-check the brand-vs-generic + strength-extraction.
const apo = matching.find((d) => d.brandName === 'Apo-Atorvastatin');
const lipitor = matching.find((d) => d.brandName === 'Lipitor');
const trueGeneric = matching.find((d) => d.brandName === 'Atorvastatin');

console.log('\n=== Spot-checks ===');
const cases: Array<{ name: string; d?: RawDrug }> = [
  { name: 'Apo-Atorvastatin (branded generic)', d: apo },
  { name: 'Lipitor (brand-name product)', d: lipitor },
  { name: 'Atorvastatin (true generic)', d: trueGeneric },
];
for (const c of cases) {
  if (!c.d) {
    console.log(`  [skip] ${c.name} not in bucket`);
    continue;
  }
  const base = cleanedMoleculeName(c.d.genericName);
  const cls = classifyRelated(c.d);
  const expectedKind =
    !c.d.brandName ||
    c.d.brandName.toLowerCase() === base ||
    c.d.brandName.toLowerCase().includes(base)
      ? 'generic'
      : 'brand';
  const ok = cls.kind === expectedKind;
  console.log(`  ${ok ? 'OK' : 'FAIL'}  ${c.name}`);
  console.log(`        cleaned base       = ${JSON.stringify(base)}`);
  console.log(`        effectiveStrength  = ${JSON.stringify(effectiveStrength(c.d))}`);
  console.log(`        classify           = ${cls.kind}/${cls.identifier}  (expected ${expectedKind})`);
}

// Liquid-concentration regex spot-check (no DIN should be in the
// atorvastatin bucket with a liquid conc, but the regex correctness
// matters for other molecules — train directly).
const cases2 = [
  { input: 'ATORVASTATIN 10 MG', want: '10 mg' },
  { input: 'INSULIN GLARGINE 100 U/ML', want: '100 u/ml' },
  { input: 'METHYLPREDNISOLONE SODIUM SUCCINATE 40 MG', want: '40 mg' },
  { input: 'EPINEPHRINE 1 MG/ML', want: '1 mg/ml' },
  { input: 'ACETAMINOPHEN 10 MG/KG', want: '10 mg/kg' },
];
console.log('\n=== Strength regex spot-check ===');
let allOk = true;
for (const c of cases2) {
  // bypass cleanedMoleculeName — just regex against genericName directly
  const fake = { genericName: c.input } as RawDrug;
  const got = effectiveStrength(fake);
  const ok = got === c.want;
  if (!ok) allOk = false;
  console.log(`  ${ok ? 'OK' : 'FAIL'}  ${c.input}  =>  ${JSON.stringify(got)}  (expected ${JSON.stringify(c.want)})`);
}
console.log(`  regex spot-check: ${allOk ? 'PASS' : 'FAIL'}`);

// Aggregate — count distinct cards with strength-aware dedup key.
const counts = { generic: 0, brand: 0 };
const cards = new Map<string, string[]>();
for (const d of matching) {
  const cls = classifyRelated(d);
  const s = effectiveStrength(d);
  counts[cls.kind]++;
  const key = `${cls.kind}|${cls.identifier}|${(s || '').toLowerCase()}|${(d.dosageForm || '').toLowerCase()}`;
  if (!cards.has(key)) cards.set(key, []);
  cards.get(key)!.push(d.id);
}

console.log('\n=== Aggregate ===');
console.log(`  Total DINs:        ${matching.length}`);
console.log(`  Classified:        generic=${counts.generic}  brand=${counts.brand}`);
console.log(`  Distinct cards:    ${cards.size}`);

const expectedCards = 10;
const ok = cards.size >= 6 && cards.size <= expectedCards;
console.log(`\nAcceptance: distinct cards in [6, ${expectedCards}] → ${ok ? 'PASS' : 'REVIEW'}  (got ${cards.size})`);

const arr = [...cards.entries()];
console.log('\nCards in collapse order:');
for (const [k, dins] of arr) {
  const sample = dins.slice(0, 3).join(', ');
  console.log(`  ${k.padEnd(64)} -> ${String(dins.length).padStart(3)} DINs  (e.g. ${sample})`);
}

if (!allOk || !ok) {
  process.exit(1);
}
