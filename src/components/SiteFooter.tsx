import Link from 'next/link';
import type { SiteMeta } from '@pipeline/types';

/**
 * Site footer. Always renders the required BC PharmaCare disclaimer and,
 * when available, surfaces the data freshness timestamp from `meta.json`.
 */
export default function SiteFooter({ meta }: { meta: SiteMeta | null }) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  const generatedHuman = meta?.generatedAt ? humanDate(meta.generatedAt) : 'unknown';
  const asOf = meta?.asOfDate ?? '';
  return (
    <footer className="site-footer">
      <div className="container">
        <p>
          <strong>Data last updated:</strong> {generatedHuman}
          {asOf && (
            <>
              {' '}
              <span className="text-muted">(as-of {asOf})</span>
            </>
          )}
        </p>
        <p>
          Drug coverage and pricing data is sourced from BC PharmaCare public
          downloadable files and may not reflect the most current or complete
          information. Provided for informational and reference purposes only;
          not a substitute for verifying coverage directly with PharmaCare or a
          patient&apos;s actual plan.
        </p>
        <p>
          <Link href={`${base}/about/`}>Data sources &amp; methodology</Link>
          {' · '}
          Not affiliated with the Government of British Columbia.
        </p>
      </div>
    </footer>
  );
}

function humanDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-CA', {
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
