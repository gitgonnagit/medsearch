'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { debounce, listCanonicalDosageForms, search, type SearchHit } from '@/lib/search-client';
import type { PriceSummary } from '@pipeline/types';

/**
 * Search box with live results and a dosage-form filter chip strip.
 * Loads the MiniSearch index lazily on first keystroke; search runs fully
 * client-side after that with no further network calls per keystroke.
 */
export default function SearchBox() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forms, setForms] = useState<string[]>([]);
  const [activeForm, setActiveForm] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus the search box on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Lazy-load dosage form filter chips once. We use the canonical
  // 8-form list (oral solid, oral liquid, etc.) — raw PDDF dosage
  // form strings produce ~50 weird categories otherwise.
  useEffect(() => {
    let cancelled = false;
    listCanonicalDosageForms()
      .then((list) => {
        if (!cancelled) setForms(list);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async (q: string) => {
    try {
      setLoading(true);
      const results = await search(q, { canonicalDosageForm: activeForm });
      setHits(results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeForm]);

  const debouncedRun = useMemo(() => debounce(run, 80), [run]);

  // Re-run with current query whenever the filter changes (no debounce for filter change).
  useEffect(() => {
    if (query.trim()) run(query);
    else setHits([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeForm]);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setQuery(next);
    if (next.trim()) debouncedRun(next);
    else setHits([]);
  };

  return (
    <div>
      <div className="search-box" role="search">
        <svg
          className="search-box__icon"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          className="search-box__input"
          type="search"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search brand, generic, or DIN…"
          value={query}
          onChange={onChange}
          aria-label="Search drugs by brand name, generic name, or DIN"
        />
      </div>
      <p className="search-box__hint">
        Typo-tolerant. Try <code>atorva</code>, <code>metfor</code>, or a DIN.
      </p>

      {forms.length > 0 && (
        <div className="filter-row" role="group" aria-label="Filter by dosage form">
          {forms.slice(0, 14).map((f) => (
            <button
              key={f}
              type="button"
              className="filter-chip"
              aria-pressed={activeForm === f}
              onClick={() => setActiveForm(activeForm === f ? null : f)}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {error && <ErrorBanner message={error} />}

      {query.trim() && (
        <div className="results" aria-live="polite">
          <p className="results__count">
            {loading
              ? 'Searching…'
              : hits.length === 0
                ? `No results for "${query}".`
                : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
          </p>
          {hits.map((h) => (
            <Link
              key={h.id}
              href={`/drug/${encodeURIComponent(h.id)}/`}
              className="result"
              prefetch={false}
            >
              <div className="result__title">
                <span className="result__brand">{h.brandName ?? h.genericName}</span>
                {h.brandName != null && h.genericName && (
                  <span className="result__generic">— {h.genericName}</span>
                )}
              </div>
              <div className="result__meta">
                <span>DIN/PIN: <span className="text-mono">{h.id}</span></span>
                {h.dosageForm && <span>{h.dosageForm}</span>}
                {h.manufacturer && <span>{h.manufacturer}</span>}
              </div>
              {h.isLimitedUse || h.inLcaCategory || h.inRdpCategory ? (
                <div className="result__badges">
                  {h.isLimitedUse && <span className="badge badge--limited">Special Authority</span>}
                  {h.inLcaCategory && <span className="badge badge--lca">LCA</span>}
                  {h.inRdpCategory && <span className="badge badge--rdp">RDP</span>}
                </div>
              ) : null}
              {h.priceSummary ? (
                <PriceBlock s={h.priceSummary} />
              ) : (
                <div className="result__not-covered">This drug is not covered</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Inline price/coverage block for a single search-result row.
 *
 * Layout mirrors drugsearch.ca's listing rows ("TOTAL COST: $X.XX for Y
 * NOUN", "PATIENTS UNDER FAIR PHARMACARE: $X.XX", "FULLY COVERED for
 * patients registered under plans X,Y") so users moving between the
 * two tools see the same numbers in the same place. Restrained:
 * small font, single-line rows, no card chrome — the row's existing
 * `.result` link styling already supplies the visual grouping, so
 * adding a background/border here would just look like clutter.
 *
 * The three lines are independent: a drug may be uncovered-but-LCA,
 * covered-but-not-under-Fair-PharmaCare, or partially covered. We
 * always render the first two; the third ("FULLY COVERED for plans
 * X,Y") only fires when at least one plan is a non-SA Covered plan
 * with a positive price.
 */
function PriceBlock({ s }: { s: PriceSummary }) {
  return (
    <div className="result__cost">
      <div className="result__cost-row">
        <span className="result__cost-label">TOTAL COST:</span>
        <span>
          <span className="result__cost-amount">${s.totalCost.toFixed(2)}</span>{' '}
          for {s.refFillUnits} {s.refFillNoun}
        </span>
      </div>
      <div className="result__cost-row">
        <span className="result__cost-label">PATIENTS UNDER FAIR PHARMACARE:</span>
        <span>
          <span className="result__cost-amount">${s.patientCost.toFixed(2)}</span>
        </span>
      </div>
      {s.fullyCoveredPlans.length > 0 && (
        <div className="result__cost-row">
          <span className="result__cost-label result__cost-label--covered">
            FULLY COVERED
          </span>
          <span>for patients registered under plans {s.fullyCoveredPlans.join(',')}</span>
        </div>
      )}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        maxWidth: 480,
        margin: '16px auto',
        padding: 12,
        background: 'var(--color-warn-soft)',
        color: 'var(--color-warn)',
        border: '1px solid rgba(146,64,14,0.25)',
        borderRadius: 8,
        fontSize: 14,
      }}
    >
      Could not load search index: {message}. Reload the page to try again.
    </div>
  );
}
