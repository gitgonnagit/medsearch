/**
 * Network + IO helpers for fetching source data from BC PharmaCare.
 *
 * - PDDF: a ZIP containing one CSV. Extracted with `yauzl` (streaming,
 *   ZIP64-safe; the PDDF archive can exceed 4GB headroom on some days).
 * - LCA / RDP: XLSX spreadsheets parsed with `xlsx`.
 * - SA drug list: an HTML page parsed with cheerio.
 */

import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import { createWriteStream, existsSync, mkdirSync, createReadStream } from 'node:fs';
import { rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';

/**
 * Generic wrapper that retries a thunk on any throw, with bounded linear
 * backoff. Used to absorb transient errors from the BC government CDN
 * (UND_ERR_SOCKET, ECONNRESET, mid-stream TCP drops, flaky 5xx) without
 * rewriting every call site.
 *
 *   - maxRetries = 3 → 4 total attempts; worst-case delay = 2 + 4 + 6 = 12s
 *     (negligible against the 90-min job timeout in CI).
 *   - Errors that retry vs. immediately bubble: every throw from the
 *     operation. We don't filter by status code because, in this pipeline,
 *     any non-OK is a terminal defect and a few extra seconds is cheap.
 *   - Each attempt re-allocates streams / re-creates the file, so retries
 *     are idempotent: `createWriteStream(dest)` truncates any partial bytes
 *     left by a previous failure.
 */
export async function withRetry<T>(operation: () => Promise<T>, tag: string, maxRetries = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (err: unknown) {
      if (attempt > maxRetries) throw err;
      const delayMs = attempt * 2000; // 2s, 4s, 6s
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[retry] ${tag} failed (${message}). Retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})…`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Unreachable');
}

async function downloadTo(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  // withRetry covers both the initial fetch (UND_ERR_SOCKET observed in
  // GH Actions on gov.bc.ca) and any mid-stream TCP drop during the body
  // pipeline.
  await withRetry(async () => {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'MedSearch/0.1 (+https://github.com/buffy/medsearch)' },
    });
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error(`No body for ${url}`);
    }
    await streamPipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
  }, `downloadTo ${url}`);
}

/**
 * Download the PDDF zip and extract the CSV inside it to `outCsvPath`.
 *
 * PDDF zip files can switch to ZIP64 between weeks; `yauzl` handles both
 * classic and ZIP64 central directories reliably.
 */
export async function fetchPddfCsv(url: string, workDir: string, outCsvPath: string): Promise<string> {
  const zipPath = join(workDir, 'pddf.zip');
  await downloadTo(url, zipPath);

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err: Error | null, zipfile: yauzl.ZipFile) => {
      if (err) {
        reject(err);
        return;
      }
      zipfile.on('error', reject as (e: Error) => void);
      zipfile.on('end', () => reject(new Error(`No CSV entry found in ${url}`)));
      zipfile.readEntry();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (!/\.csv$/i.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (rsErr: Error | null, readStream: NodeJS.ReadableStream) => {
          if (rsErr) {
            reject(rsErr);
            return;
          }
          const out = createWriteStream(outCsvPath);
          readStream.on('error', reject as (e: Error) => void);
          out.on('error', reject as (e: Error) => void);
          out.on('finish', () => {
            zipfile.close();
            resolve();
          });
          readStream.pipe(out);
        });
      });
    });
  });

  return outCsvPath;
}

/** Download an xlsx and return parsed rows as objects (first sheet).
 *
 * BC PharmaCare LCA/RDP xlsx files put a merged-cell title in row 0 and
 * the real headers in row 1, so we pass `range: 1` to skip the title row.
 */
async function fetchXlsxRows(url: string, workDir: string): Promise<Record<string, unknown>[]> {
  const xlsxPath = join(workDir, url.split('/').pop()!);
  await downloadTo(url, xlsxPath);
  const wb = XLSX.readFile(xlsxPath);
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) throw new Error(`Empty workbook from ${url}`);
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[firstSheet], {
    defval: '',
    range: 1, // skip row 0 (merged-cell title)
  });
}

/** Public: fetch the current LCA spreadsheet. */
export async function fetchLcaXlsx(url: string, workDir: string): Promise<Record<string, unknown>[]> {
  return fetchXlsxRows(url, workDir);
}

/** Public: fetch the current RDP spreadsheet. */
export async function fetchRdpXlsx(url: string, workDir: string): Promise<Record<string, unknown>[]> {
  return fetchXlsxRows(url, workDir);
}

/** Download the SA drug list HTML page. */
export async function fetchSaListHtml(url: string, workDir: string): Promise<string> {
  const htmlPath = join(workDir, 'sa-list.html');
  await downloadTo(url, htmlPath);
  return readFile(htmlPath, 'utf8');
}

/**
 * Parse the BC PharmaCare SA drug list HTML into structured rows.
 * The published table is two columns: Generic drug name | Brand drug name.
 * The generic cell links to criteria/form when present.
 */
export function parseSaListRows(html: string): Array<{ genericName: string; brandNames: string[]; saLink: string | null }> {
  const $ = cheerio.load(html);
  const SA_BASE = 'https://www2.gov.bc.ca';
  const rows: Array<{ genericName: string; brandNames: string[]; saLink: string | null }> = [];
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 2) return;
    const genericCell = $(cells[0]);
    const brandCell = $(cells[1]);
    const genericName = genericCell.text().trim().replace(/\s+/g, ' ');
    const brandNameRaw = brandCell.text().trim().replace(/\s+/g, ' ');
    if (!genericName) return;
    const saLinkRaw = genericCell.find('a').attr('href') ?? null;
    const saLink = saLinkRaw
      ? /^https?:/i.test(saLinkRaw)
        ? saLinkRaw
        : SA_BASE + (saLinkRaw.startsWith('/') ? saLinkRaw : '/' + saLinkRaw)
      : null;
    const brandNames = brandNameRaw
      .split(/,|\s+and\s+/i)
      .map((s) => s.trim().replace(/®|™|&reg;|&trade;/g, ''))
      .filter(Boolean);
    rows.push({ genericName, brandNames, saLink });
  });
  return rows;
}

/** Best-effort cleanup helper for tools/CI. */
export async function cleanupDir(dir: string): Promise<void> {
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
}
