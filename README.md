# MedSearch

A fast, free, static-site replacement for the BC PharmaCare drug lookup workflow.
Built for pharmacists and prescribers who need a clinical-level view of coverage,
pricing, and Special Authority status without the lag of the government reference
tools.

> Project status: scaffolding complete; pipeline runs end-to-end against live
> government data; first static build pending.
>
> See [`build.md`](./build.md) for the full product brief that drove every
> decision below.

---

## Why this exists

The existing reference tool queries relational government data live per
request: every search keystroke and every detail-page click is a server
round-trip against multi-row tables. That architecture explains why the
tool feels slow and why detail pages sometimes don't resolve at all.

MedSearch fixes the problem architecturally, not with a faster server:

1. **Pre-process the source data into a clean, current, denormalised
   dataset** on a schedule.
2. **Ship a prebuilt client-side search index** with the static site.
3. **Statically generate one HTML page per DIN/PIN at build time** so a
   detail-page click loads from a single round-trip that's already in the
   browser.
4. **No backend. No database. $0/month forever.**

The result: searches are instant (no network per keystroke); detail pages
never spin because they're plain HTML; the whole site costs nothing to host.

---

## Architecture at a glance

```
┌─────────────────────┐    weekly cron      ┌──────────────────────┐
│ BC PharmaCare PDDF  │ ──────────────────► │ pipeline/ (Node)     │
│ + LCA/RDP xlsx      │                    │  • download          │
│ + SA drug list HTML │                    │  • parse & filter    │
└─────────────────────┘                    │  • aggregate per DIN │
                                           │  • enrich (SA/LCA/RDP)│
                                           │  • build MiniSearch   │
                                           └──────────┬───────────┘
                                                      │ writes
                              ┌──────────────────────┴──────────────────────┐
                              │                                             │
                              ▼                                             ▼
                ┌────────────────────────────┐            ┌────────────────────────────┐
                │ data-cache/drugs.json      │            │ public/data/                │
                │ (read by Next.js at build) │            │  search-index.json          │
                │                            │            │  related.json               │
                └────────────┬───────────────┘            │  meta.json                  │
                             │                            └────────────┬───────────────┘
                             ▼                                         │ ships to browser
                ┌────────────────────────────┐                         │
                │ src/app/drug/[din]         │                         ▼
                │ generateStaticParams →     │              ┌──────────────────────┐
                │ one HTML file per DIN      │              │ Browser              │
                │ data fully embedded inline │              │  • MiniSearch.loadJS │
                └────────────┬───────────────┘              │  • instant results   │
                             │                              │  • /drug/<din>/.html │
                             ▼                              └──────────────────────┘
                ┌────────────────────────────┐
                │ out/                       │  ─────────►  GitHub Pages
                │ (Next.js static export)    │
                └────────────────────────────┘
```

---

## Repo layout

```
.
├── build.md                — full product brief (source of truth)
├── package.json
├── tsconfig.json
├── next.config.mjs         — output: 'export' (static site generator)
├── pipeline/               — data-pipeline scripts (run with tsx)
│   ├── run.ts              — orchestrator: download → parse → enrich → index
│   ├── check.ts            — post-run smoke check (used in CI)
│   ├── sources.ts          — fetch + extract PDDF zip, LCA/RDP xlsx, SA HTML
│   ├── parse.ts            — filter to currently-active rows, aggregate per DIN
│   ├── enrich-sa.ts        — scrape SA drug list, fuzzy-match by generic name
│   ├── enrich-lca-rdp.ts   — link DINs to LCA/RDP categories from xlsx
│   ├── group-related.ts    — group drugs by normalized generic key
│   ├── index-builder.ts    — MiniSearch serialization + companion data
│   ├── helpers.ts          — date parsing, normalization, plan semantics
│   └── types.ts            — shared Drug / PlanCoverage types
├── src/                    — Next.js (App Router) frontend
│   ├── app/
│   │   ├── layout.tsx      — root layout with header/footer
│   │   ├── page.tsx        — search home
│   │   ├── about/page.tsx  — data sources, methodology, freshness
│   │   └── drug/[din]/page.tsx — drug detail (statically generated)
│   ├── components/         — SiteHeader, SiteFooter, SearchBox, etc.
│   ├── lib/
│   │   └── search-client.ts — daily-loaded browser search client
│   └── app/globals.css     — design system (Wealthsimple-inspired)
├── data-cache/             — gitignored; produced by pipeline; read at build time
├── public/data/            — gitignored; produced by pipeline; ships to browser
└── .github/workflows/
    └── refresh.yml         — weekly cron + manual dispatch
```

---

## How to run locally

```bash
# 1. Install deps.
npm install

# 2. Run the data pipeline (downloads live government data).
npm run pipeline
# Output: data-cache/drugs.json + public/data/{search-index,related,meta}.json

# 3. Smoke check the outputs.
npm run pipeline:check

# 4. Build the static site.
# Set MEDSEARCH_DRUG_LIMIT=N for a fast local smoke build (e.g. 500).
MEDSEARCH_DRUG_LIMIT=500 npm run build

# 5. Or run the dev server (hot reload; will read from data-cache).
npm run dev
```

The static export goes to `out/`. Serve it with any static host, but the
**production target is GitHub Pages** — and the project is wired so that
the GitHub Actions workflow in `.github/workflows/refresh.yml` deploys
straight to it without any manual steps.

---

## Pipeline: what gets parsed and how

The BC PharmaCare downloadable drug data file (PDDF) is one zipped CSV
(~3 MB) updated **weekly on Tuesday mornings**. The CSV has ~296k rows
covering every historical record — one row per drug per PharmaCare plan
per effective-date period. We:

1. **Filter to currently-active rows** (`Rec Eff Date ≤ today ≤ Rec End Date`,
   with blank `Rec End Date` treated as open-ended).
2. **Aggregate to one record per DIN/PIN**, carrying the most recent active
   row's title info plus every active per-plan coverage entry.
3. **Compute coverage status per plan** using the priority order:
   Limited Use → RDP price (if plan isn't excluded) → LCA price → max price.
4. **Enrich from LCA/RDP xlsx files and the SA HTML list.**
5. **Build a MiniSearch index** over brand name (×2), generic name (×1),
   dosage form (×1.5), manufacturer (×0.5), and DIN, with prefix + 0.2
   fuzzy tolerance for typo-friendly as-you-type search.
6. **Write** `data-cache/drugs.json`, `public/data/search-index.json`,
   `public/data/related.json`, `public/data/meta.json`.

If you want a deterministic snapshot (for testing), set
`MEDSEARCH_AS_OF=YYYY-MM-DD` before running.

---

## Special Authority matching (known limitations)

The government Special Authority drug list is published as a single HTML
table; matching is best-effort:

- **Pass 1:** exact match on a normalized generic-name hash.
- **Pass 2:** Fuse.js fuzzy match at a conservative threshold for misses.

Drugs that match get a direct link to their specific criteria/forms.
**Drugs that don't match get a fallback link to the general SA directory**
so you're never at a dead end. The build emits `data-cache/unmatched-sa.json`
which lists every DIN that fell back to the directory link — review this
file after each build to spot systemic misses.

If you want to override a specific match, add an entry to
`data-cache/sa-overrides.json` as `{ "<DIN>": "<url>" }`. (Slot for this
override is reserved; wire it into `enrich-sa.ts` if you actually need
manual lookups.)

---

## Deploy to GitHub Pages

1. Push the repo to GitHub.
2. In repo settings → Pages → set Source to **GitHub Actions**.
3. The `.github/workflows/refresh.yml` workflow:
   - Runs on a Tuesday cron (18:00 UTC = 11:00 PDT) and on manual dispatch.
   - Installs deps, runs the full pipeline, smoke-checks the outputs.
   - Builds the static site (full DIN count, no `MEDSEARCH_DRUG_LIMIT`).
   - Deploys via the official `actions/deploy-pages` action.

If you publish to a **project page** (`<owner>.github.io/<repo>`), set
the repository variable `NEXT_PUBLIC_BASE_PATH=/<repo>` so search fetches
resolve. On a user page (`<owner>.github.io/`), leave it empty.

### Custom domain

After first deploy:

1. Add your CNAME file to `public/CNAME` (e.g. `medsearch.example.com`).
2. Configure DNS as per GitHub's instructions.
3. Remove `NEXT_PUBLIC_BASE_PATH` (or set to `/`) and re-run the workflow.

No code changes are required to attach a custom domain later — that's a
key reason we ship everything as static files.

---

## Design

The site follows a Wealthsimple-inspired minimal aesthetic:

- Off-white background (`#fafafa`), near-black text (`#161616`).
- One confident accent (ink teal `#0f766e`) used sparingly for badges,
  interactive elements, and the logo.
- Generous whitespace, clean cards instead of dense tables where possible.
- Inter via `next/font` for typography.
- Mobile-first; full layout re-checks at every breakpoint.
- All transitions respect `prefers-reduced-motion`.

Tokens live in `src/app/globals.css` under `:root`. Components reference
these via class names (`badge--covered`, `hero__title`, etc.).

---

## Costs

This project is designed to cost **$0 per month indefinitely**:

- GitHub Actions: free public-repo allowance is generous; this workflow
  runs ~5–15 minutes weekly and uses <500 MB peak RAM.
- GitHub Pages: free static-site hosting on a public repo, 1 GB storage,
  100 GB bandwidth / month — sufficient for any realistic usage of a
  clinical reference tool.
- No domain required (use `username.github.io/medsearch`).

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ADM-ZIP: Descriptor data is malformed` | We're now using `yauzl` which handles ZIP64 properly. Make sure you're on the latest code. |
| `XLSX.readFile is not a function` | Make sure `package.json` has `"type": "module"` and imports use `import XLSX from 'xlsx'`. |
| `No CSV entry found in <url>` | Government occasionally renames the file in the zip. The extractor matches any `.csv` extension; check the URL if it persists. |
| Build OOMs locally | Set `MEDSEARCH_DRUG_LIMIT=500` to generate only the first 500 DINs for a quick build sanity check. CI always builds the full set. |
| Blank drug page | Drug dataset missing: run `npm run pipeline` first; the build reads `data-cache/drugs.json`. |

---

## License & data attribution

Drug data is sourced from BC PharmaCare public files and is provided
"as-is"; we explicitly disclaim it as not authoritative. See the
site footer for the full disclaimer. MedSearch is not affiliated with
the Government of British Columbia.

Source files:

- [BC PharmaCare Downloadable Drug Data File](https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/health-industry-professional-resources/downloadable-drug-data-files)
- [LCA / RDP data files](https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/pharmacies/low-cost-alternative-lca-and-reference-drug-program-rdp-data-files)
- [Special Authority drug list](https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/programs/special-authority/sa-drug-list)
