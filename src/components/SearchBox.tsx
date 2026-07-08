'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { debounce, listDosageForms, search, type SearchHit } from '@/lib/search-client';

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

  // Lazy-load dosage form filter chips once.
  useEffect(() => {
    let cancelled = false;
    listDosageForms()
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
      const results = await search(q, { dosageForm: activeForm });
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

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

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
              href={`${base}/drug/${encodeURIComponent(h.id)}/`}
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
            </Link>
          ))}
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
