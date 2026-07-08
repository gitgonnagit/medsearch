import Link from 'next/link';

/**
 * Site header. Sticky, blurred, with a simple geometric pill-in-circle logo
 * drawn inline (no asset fetches) so it always renders on first paint.
 */
export default function SiteHeader() {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link href={`${base}/`} className="site-header__brand">
          <svg
            className="site-header__logo"
            viewBox="0 0 24 24"
            role="img"
            aria-label="MedSearch"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="2" />
            <rect x="6" y="10" width="12" height="6" rx="3" fill="currentColor" />
          </svg>
          <span>MedSearch</span>
        </Link>
        <nav className="site-header__nav" aria-label="Primary">
          <Link href={`${base}/`}>Search</Link>
          <Link href={`${base}/about/`}>About</Link>
        </nav>
      </div>
    </header>
  );
}
