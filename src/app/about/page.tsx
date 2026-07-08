import type { Metadata } from 'next';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Link from 'next/link';
import type { SiteMeta } from '@pipeline/types';

export const metadata: Metadata = {
  title: 'About MedSearch',
  description:
    'What MedSearch is, where its data comes from, how the pipeline works, and its known limitations.',
  alternates: { canonical: '/about/' },
};

async function loadMeta(): Promise<SiteMeta | null> {
  const candidates = [
    join(process.cwd(), 'data-cache', 'meta.json'),
    join(process.cwd(), 'public', 'data', 'meta.json'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8')) as SiteMeta;
  }
  return null;
}

export default async function AboutPage() {
  const meta = await loadMeta();
  return (
    <article className="container about">
      <h1>About MedSearch</h1>
      <p className="text-muted">
        MedSearch is a fast, free, static-site replacement for the BC PharmaCare
        drug lookup workflow. It is built for pharmacists and prescribers who
        need a clinical-level view of coverage, pricing, and Special Authority
        status without the lag of the government&apos;s reference tools.
      </p>

      <h2>What this tool is &mdash; and isn&apos;t</h2>
      <ul>
        <li>
          <strong>Is:</strong> a fast, offline-capable lookup of BC PharmaCare
          coverage, plan-level pricing, LCA/RDP category membership, and Special
          Authority requirements.
        </li>
        <li>
          <strong>Isn&apos;t:</strong> an authoritative clinical reference.
          Always verify a specific patient&apos;s coverage directly with
          PharmaCare before dispensing.
        </li>
      </ul>

      <h2>Data sources</h2>
      <ul>
        <li>
          <a
            href="https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/health-industry-professional-resources/downloadable-drug-data-files"
            rel="noopener noreferrer"
            target="_blank"
          >
            BC PharmaCare Downloadable Drug Data File (PDDF)
          </a>{' '}
          &mdash; updated weekly on Tuesday morning. This is the source of truth
          for per-plan coverage and pricing.
        </li>
        <li>
          <a
            href="https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/pharmacies/low-cost-alternative-lca-and-reference-drug-program-rdp-data-files"
            rel="noopener noreferrer"
            target="_blank"
          >
            LCA / RDP data files
          </a>{' '}
          &mdash; updated monthly on the first Thursday. Used to enrich group
          membership for cross-linking.
        </li>
        <li>
          <a
            href="https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/programs/special-authority/sa-drug-list"
            rel="noopener noreferrer"
            target="_blank"
          >
            Special Authority drug list
          </a>{' '}
          &mdash; HTML table linking Limited Use drugs to their criteria/forms.
          Best-effort matched on normalized generic name. Drugs whose match is
          ambiguous still link to the directory page so you&apos;re never at a
          dead end.
        </li>
        <li>
          <a
            href="https://health-products.canada.ca/dpd-bdpp/"
            rel="noopener noreferrer"
            target="_blank"
          >
            Health Canada Drug Product Database
          </a>{' '}
          &mdash; linked out from each drug&apos;s detail page for full
          monographs.
        </li>
      </ul>

      <h2>Methodology</h2>
      <p>
        Each Tuesday a scheduled workflow downloads the latest PDDF, parses it
        with strict date-window filtering (Rec Eff Date &le; today &le; Rec End
        Date), aggregates one record per DIN/PIN with a list of its active
        per-plan coverage entries, enriches with LCA/RDP group membership and
        Special Authority links, builds a MiniSearch index over brand, generic,
        dosage form, and DIN, then re-deploys the static site. Search runs
        entirely client-side &mdash; there is no backend, no database, and no
        per-request server cost.
      </p>
      <p>
        We display Max Price, LCA Price, and RDP Price exactly as published,
        clearly labelled as the maximum recognized reimbursement for the
        prescription. We do <em>not</em> estimate patient out-of-pocket cost
        because the calculation requires pharmacy-specific dispensing fees and
        patient-specific deductibles that are not in the source data.
      </p>

      <h2>Known limitations</h2>
      <ul>
        <li>
          Special Authority link matching is best-effort: when a confident
          match can&apos;t be made, the detail page links to the general SA
          directory instead of a specific criteria page.
        </li>
        <li>
          The PDDF source has no dedicated strength column; strength is embedded
          in the brand/generic name strings and is not used to differentiate
          &quot;other drugs in the same generic group&quot; here (every drug
          sharing a normalized generic name is treated as interchangeable).
        </li>
        <li>
          The dataset is one snapshot per pipeline run; live status changes
          between runs are not reflected until the next scheduled refresh.
        </li>
      </ul>

      <h2>Freshness</h2>
      {meta ? (
        <p>
          Pipeline last ran on <strong>{meta.generatedAt}</strong> with an
          as-of date of <strong>{meta.asOfDate}</strong>. The site contains{' '}
          <strong>{meta.drugCount.toLocaleString()}</strong> active drug
          records.
        </p>
      ) : (
        <p className="text-muted">
          Freshness metadata not found in this build. Run the pipeline locally
          or in CI to populate; see the project README.
        </p>
      )}

      <p>
        <Link href="/">&larr; Back to search</Link>
      </p>
    </article>
  );
}
