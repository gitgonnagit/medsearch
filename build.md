# Build Prompt: MedSearch — BC PharmaCare Drug Search Tool

Copy everything below into your coding agent (with web access, file/shell access, and the ability to create a git repo and push to GitHub). It is written as a complete, standalone brief — the agent should not need to come back to the user for basic decisions; where something is genuinely ambiguous, make a reasonable choice, document it in the README, and keep moving.

---

## 1. Mission

Build **MedSearch**, a fast, clean, BC PharmaCare drug lookup tool for pharmacists and prescribers. It replaces the workflow of an existing tool called drugsearch.ca, which has the right idea but is frustratingly slow: searches lag, and drug detail pages sometimes fail to load at all. Your job is to build a version that is instant, reliable, and free to run indefinitely.

**Audience:** pharmacists and prescribers — not lay patients. Show clinical-level detail (DIN, dosage form, benefit group codes, RDP category, plan-by-plan pricing) rather than simplified consumer language. Assume the user knows pharmacy terminology.

**Non-negotiable outcome:** typing in the search box returns results with no perceptible lag (no network round-trip per keystroke), and clicking any drug always loads its detail page immediately, every time, with no spinner-that-never-resolves failure mode. This is the entire reason this project exists — treat it as the top-priority constraint that should shape your architecture decisions below, not an afterthought.

---

## 2. Why the original is slow (diagnose, then avoid)

The BC government's source data is **relational, not a clean lookup table**: it has one row per drug (DIN), per PharmaCare plan, per effective-date period — so a single drug can have dozens of historical rows. If a tool queries this live/raw on every keystroke or per click, that fully explains sluggish search and detail pages that sometimes don't resolve.

**The fix is architectural, not a faster server:** pre-process the government data into a clean, current, denormalized dataset *ahead of time* (on a schedule, not per-request), ship it as a prebuilt static search index, and do all searching client-side, in the browser, with zero network calls after the initial page load. This also means the site can run on $0/month hosting forever with no database to provision or pay for. Do not build a live backend API that queries a database per search request — that reintroduces the exact problem you're fixing.

---

## 3. Data sources

Verify current file formats yourself before writing parsing code — government file layouts occasionally change, and you should trust what you find live over what's written here.

### 3.1 Main PharmaCare Downloadable Data File
- Landing page: `https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/health-industry-professionals/downloadable-drug-data-files`
- Delivered as a zipped CSV (~3MB zipped), **updated weekly, Tuesday mornings**.
- Field-layout / interpretation document (PDF): `https://www2.gov.bc.ca/assets/gov/health/health-drug-coverage/pharmacare/pddf-inter.pdf` — fetch and parse this to confirm exact column names/order before writing your parser.
- As of this research, the schema includes (verify before relying on it): DIN/PIN, Plan code, Record Effective Date, Record End Date, Benefit Group List, LCA Indicator, Pay Generic Indicator, Brand Name, Manufacturer, Generic Name, Dosage Form, Trial Flag, Maximum Price, LCA Price, RDP Category, RDP Sub-Category, RDP Price, RDP Excluded Plans, Canadian Federal Regulation Code, PharmaCare Plan Description, Max Days Supply, Quantity Limit, Formulary List Date, Limited Use (Special Authority) Flag.
- **Critically: one DIN can have many rows** (per plan, per historical period). For your processed dataset, keep only the row(s) where today's date falls within [Record Effective Date, Record End Date] (or Record End Date is blank/open-ended) — i.e., the *currently active* record per DIN per plan. Collapse multiple plans covering the same DIN into a single per-drug record with a list of plan-level coverage entries.

### 3.2 Low Cost Alternative (LCA) & Reference Drug Program (RDP) data
- Landing page: `https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/pharmacies/low-cost-alternative-lca-and-reference-drug-program-rdp-data-files`
- Delivered as spreadsheet(s) (xls/xlsx), **updated monthly, first Thursday**.
- Use this to enrich/cross-check LCA and RDP pricing/category data already present in the main file, and as the source of truth for LCA/RDP group membership (i.e., which drugs are interchangeable alternatives within a category) if the main file doesn't fully capture it.

### 3.3 Special Authority drug list (for the "requires Special Authority" feature)
- Table page: `https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/programs/special-authority/sa-drug-list` — a searchable table linking each limited-coverage drug to its specific coverage criteria and request form.
- General SA forms index: `https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare/programs/special-authority/special-authority-request-forms-drugs-medical-devices-and-supplies`
- The main data file's Limited Use / Special Authority flag tells you *which* drugs need this treatment; this page is where you get the *link to the actual criteria/form*. During your data pipeline, fetch this table and best-effort match its drug names against your dataset's generic names. Where a confident match exists, store the direct criteria/form link. Where it doesn't, fall back to linking the drug's detail page to the general SA drug list page with the drug name as context, so the user is never left with a dead end. Document your matching approach and its limitations in the README — this is the one part of the pipeline that's inherently a bit fuzzy, and that's fine as long as it's honest about it.

### 3.4 Optional enrichment
- Health Canada Drug Product Database (`https://health-products.canada.ca/dpd-bdpp/`) can be linked from each drug's detail page (by DIN) for users who want the full product monograph. This is a nice-to-have, not required.

### 3.5 Data licensing & disclaimer
BC government data of this kind is typically provided "as-is" for informational convenience and explicitly disclaimed as not authoritative/guaranteed current. Carry an equivalent disclaimer on the site (see Section 8) and confirm the specific terms-of-use text on the source pages before finalizing your footer wording.

---

## 4. Required architecture

1. **Data pipeline** (a script, run on a schedule — see Section 6): downloads the source files above, parses them, filters to current records, aggregates to one clean object per DIN with nested plan-level coverage/pricing, merges LCA/RDP detail, attaches Special Authority links, and outputs:
   - a compact JSON dataset (one entry per drug), and
   - a prebuilt client-side search index over brand name, generic name, and DIN (typo-tolerant / prefix matching), built with a lightweight library such as MiniSearch or FlexSearch, serialized so it can be loaded once by the browser with no rebuild-on-load cost.
2. **Frontend**: a static site (Next.js with static export, or Vite + React — your call, default to Next.js static export unless you have a strong reason otherwise) that:
   - loads the prebuilt index once and searches entirely client-side (in a Web Worker if the dataset is large enough to risk jank on the main thread) — no network call per keystroke;
   - statically generates a detail page for every DIN at build time, so clicking a result never triggers a fetch that can hang or fail — the data is already on the page.
3. **No backend server, no database, no paid search service.** Everything is static files + a browser-side index. This is what makes both "fast" and "free forever" possible simultaneously.
4. **Hosting**: GitHub Pages (simplest, one ecosystem, fully free, works cleanly with the GitHub Actions pipeline below) or Cloudflare Pages (also free, slightly better edge performance, easy to attach a custom domain later). Avoid Vercel/Netlify's free "Hobby" tiers for this if you can — their free-tier terms are scoped to non-commercial personal use and a public clinical tool sits in a gray area there. Default to GitHub Pages unless you have a good reason to deviate; document your choice.
5. No domain is currently owned — use the free subdomain the host provides (e.g. `<username>.github.io/medsearch` or a `.pages.dev` address). Structure the project so a custom domain could be attached later with minimal changes.

---

## 5. Feature requirements (parity with drugsearch.ca, executed properly)

- **Search** by brand name, generic name, or DIN, with instant as-you-type results (fuzzy/typo-tolerant, not just exact-prefix).
- **Filter** results by dosage form / route of administration (e.g., inhaled vs. topical vs. oral).
- **Per-plan coverage**: for each PharmaCare plan, show whether the drug is covered, at what price, and any relevant plan-specific notes (deductibles are plan-level and don't need to be computed here, but the coverage status and price should be clear).
- **Patient price**, inclusive of the standard PharmaCare dispensing fee methodology where the source data supports it — clearly label any assumptions made in this calculation.
- **Special Authority flag**: prominently indicate when Special Authority is required, with a direct link to criteria/forms (per Section 3.3).
- **LCA / RDP context**: show LCA price and RDP category/price where applicable, since these directly affect what a patient actually pays for multi-source or reference-category drugs.
- **Brand vs. generic**: when searching a brand name, surface its generic equivalent(s) and vice versa.
- Do **not** add scope beyond this (no pharmacy locator, no price history charts) — the goal is feature parity with drugsearch.ca, done fast and well, not a bigger product.

---

## 6. Automated weekly data refresh (must be fully hands-off)

Set up a **GitHub Actions scheduled workflow** (cron) that:
1. Runs weekly, timed after the government's Tuesday-morning update (build in a buffer — e.g. Tuesday afternoon Pacific time — and convert correctly to UTC in the cron expression).
2. Re-runs the full data pipeline (Section 4.1) against the live source files.
3. If the processed output changed, commits the new JSON/index files back to the repo and pushes.
4. That push should automatically trigger your static host's deploy (GitHub Pages/Cloudflare Pages both redeploy on push) — no manual step required.
5. Also schedule a monthly check (or just let the weekly run double as the check) for the LCA/RDP files, since those update on their own first-Thursday-of-month cadence.
6. This entire loop must cost $0 — GitHub Actions is free for this workload, and both recommended hosts have free static-site tiers with no bandwidth billing surprises at this traffic scale.

Stamp the site with a visible **"data last updated: [date]"** indicator sourced from the pipeline run, so users can see freshness at a glance.

---

## 7. Design direction — Wealthsimple-inspired

Reference: `https://www.wealthsimple.com/en-ca`. You may fetch and inspect it directly if you have browsing access. Aim for the same *feeling*, not a literal clone:

- **Typography**: large, confident, bold headlines paired with a clean, highly legible sans-serif for body/data (e.g. Inter, or a similar free geometric/grotesk sans — Wealthsimple's proprietary typeface isn't freely licensable, so pick a close, freely-licensed equivalent). Strong type-scale hierarchy; don't be afraid of big whitespace around headlines.
- **Layout**: generous negative space, minimal chrome, content organized into clean cards/sections rather than dense tables where possible — though given the clinical audience, a well-designed data table for plan-by-plan pricing on the detail page is appropriate and expected; make it clean rather than cramped.
- **Color**: a calm, mostly neutral palette (off-white/soft gray backgrounds, near-black text) with **one confident accent color** used sparingly for interactive elements, badges (e.g. "Special Authority required," "Covered," "Not covered"), and the logo.
- **Motion**: subtle, purposeful micro-interactions (gentle hover states, smooth focus transitions on the search box) — nothing gimmicky, nothing that adds perceived latency.
- **Mobile-first, fully responsive** — pharmacists will use this on phones at the counter as often as on desktop.
- Consult the frontend-design skill/guidance available to you (if your environment has one) before writing component code, so spacing, type scale, and color tokens are applied consistently rather than ad hoc.

---

## 8. Branding

- **Name**: MedSearch.
- **Logo**: a simple, geometric icon related to medication/pharmacy (e.g. a stylized pill, capsule, or an Rx/cross mark), rendered in the site's single accent color, consistent with the minimal Wealthsimple-inspired aesthetic — not a literal clip-art pill icon. Keep it simple enough to work as a small favicon too.
- **Footer disclaimer** (required on every page): state clearly that data is sourced from BC PharmaCare public data files, may not reflect the most current or complete information, is provided for informational/reference purposes only, and is not a substitute for verifying coverage directly with PharmaCare or a patient's actual plan. Include the "data last updated" timestamp here too.

---

## 9. Site structure

- `/` — search home: prominent search bar (hero-style, Wealthsimple-esque), instant results below/inline as the user types.
- `/drug/[din]` — statically generated detail page per drug: brand + generic name, manufacturer, dosage form, DIN, per-plan coverage table (plan, covered y/n, price, notes), LCA/RDP details, Special Authority badge + link if applicable, max days supply / quantity limit, link to Health Canada DPD monograph.
- `/about` — what this tool is, data sources and cadence, disclaimer, contact/feedback (no account system, no personal data collection — keep it simple and privacy-clean since no patient information is ever entered or stored).

---

## 10. Build phases

1. **Verify data schemas** — fetch and read the interpretation PDF and both data-file landing pages live; confirm field names/order match Section 3 before writing parsers; note any discrepancies in the README.
2. **Build the data pipeline script** — download, parse, filter-to-current, aggregate per DIN, merge LCA/RDP, attach Special Authority links, output dataset + search index JSON. Run it once locally/in-CI to generate the first dataset.
3. **Scaffold the frontend** with the chosen framework, wire up the search box to the prebuilt index (client-side only), confirm search is instant with no network calls in the browser dev tools network tab.
4. **Build the detail page template** and statically generate it for every DIN; confirm every generated page loads with no fetch/spinner dependency.
5. **Apply the design system** from Section 7 across all pages; make sure mobile is fully usable, not just "doesn't break."
6. **Wire up the GitHub Actions weekly refresh workflow** (Section 6); test it manually via workflow dispatch to confirm the full loop (fetch → process → commit → deploy) works end to end before relying on the schedule.
7. **Deploy** to the chosen free host and confirm the live URL works, including on mobile.
8. **Write a README** covering: architecture decisions and why, how to run the pipeline manually, how the Special Authority matching works and its known limitations, how to change the refresh schedule, and how to later attach a custom domain.

---

## 11. Definition of done — verify all of these before considering this finished

- [ ] Typing a partial brand or generic name returns results with no visible lag and no network requests firing per keystroke (verify in browser dev tools).
- [ ] Every single drug result, when clicked, loads its detail page immediately — test this across at least a few dozen random DINs, not just the first few you tried.
- [ ] Special Authority–flagged drugs show a clear badge and a working link to criteria/forms (direct link where matched, sensible fallback where not).
- [ ] Plan-by-plan coverage and pricing display correctly for a drug you can manually cross-check against the raw government CSV.
- [ ] Site is fully usable on a phone-sized viewport.
- [ ] "Data last updated" timestamp is visible and accurate.
- [ ] Disclaimer is present on every page (footer is fine).
- [ ] GitHub Actions weekly workflow has been test-run successfully at least once via manual dispatch.
- [ ] Total monthly hosting/infrastructure cost is $0.
- [ ] Live URL is deployed and working; share it back along with a short summary of any architecture decisions you made where this brief left something open.