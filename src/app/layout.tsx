import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteMeta } from '@pipeline/types';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'MedSearch — BC PharmaCare drug lookup',
    template: '%s · MedSearch',
  },
  description:
    'Fast, offline-first BC PharmaCare drug search for pharmacists and prescribers.',
  applicationName: 'MedSearch',
  authors: [{ name: 'MedSearch' }],
  openGraph: {
    title: 'MedSearch',
    description: 'Fast, offline-first BC PharmaCare drug lookup.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#fafafa',
  width: 'device-width',
  initialScale: 1,
};

/** Read site meta at build time so footer can show "data last updated". */
async function loadSiteMeta(): Promise<SiteMeta | null> {
  const candidates = [
    join(process.cwd(), 'data-cache', 'meta.json'),
    join(process.cwd(), 'public', 'data', 'meta.json'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as SiteMeta;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const meta = await loadSiteMeta();
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter meta={meta} />
      </body>
    </html>
  );
}
