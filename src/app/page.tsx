import type { Metadata } from 'next';
import SearchBox from '@/components/SearchBox';

export const metadata: Metadata = {
  title: 'Search BC PharmaCare drugs',
  description:
    'Instant client-side search across BC PharmaCare drug coverage data: brand name, generic name, or DIN. No sign-in, no tracking, no waiting.',
  alternates: { canonical: '/' },
};

export default function HomePage() {
  return (
    <>
      <section className="hero container">
        <h1 className="hero__title">BC PharmaCare drug lookup.</h1>
        <p className="hero__subtitle">
          Instant, offline-friendly search across PharmaCare coverage data. Built
          for pharmacists and prescribers.
        </p>
        <SearchBox />
      </section>
    </>
  );
}
