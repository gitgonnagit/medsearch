import Link from 'next/link';

/**
 * Site header. Sticky, blurred, with a simple geometric pill-in-circle logo
 * drawn inline (no asset fetches) so it always renders on first paint.
 *
 * Link hrefs are written WITHOUT a `${base}/` prefix because Next.js's
 * `basePath` config (set in `next.config.mjs`) automatically prepends the
 * project-site subpath at render time. Previously we did
 * `<Link href={`${base}/`}>` AND relied on `basePath`, which produced
 * `/medsearch/medsearch/` after page render.
 */
export default function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link href="/" className="site-header__brand">
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
          <Link href="/">Search</Link>
          <Link href="/about/">About</Link>
        </nav>
      </div>
    </header>
  );
}
