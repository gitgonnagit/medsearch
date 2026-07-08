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
 * True if `err` looks like a transient network failure we should retry:
 * undici's `UND_ERR_*` family (incl. UND_ERR_CONNECT_TIMEOUT, UND_ERR_SOCKET)
 * and Node's `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`,
 * `ECONNREFUSED`, `EPIPE`. Also catches the DOMException `TimeoutError`
 * that AbortSignal.timeout raises, and the `ABORT_ERR` AbortError from
 * fetch. HttpClient errors (4xx/5xx) are NOT transient — they're a problem
 * with the request, not the transport.
 *
 * NB: Node's native fetch() throws `new TypeError('fetch failed')` for
 * every transport-level failure, wrapping the real undici error in
 * `err.cause` (ConnectTimeoutError, UND_ERR_SOCKET, etc.). The thrown
 * TypeError carries no `.code` and its `.name` is just "TypeError", so
 * the code-name checks below wouldn't classify it as transient without
 * help. We eagerly match the message text AND inspect `err.cause.name`
 * (and `err.cause.code`) to make sure retry actually fires on the
 * generic TypeError. Without this, the workflow dies on the first
 * gov.bc.ca CDN hiccup because retries never trigger.
 */
/** Exported for tests in scripts/test-fetch-retry.mts; not part of the
 *  wrapper public API. Defensive `err.name === 'TypeError'` is included
 *  alongside the message check so future maintainers reading this know
 *  it's the fetch()-specific wrapping behaviour we're matching against
 *  (every Node fetch() transport failure throws `TypeError('fetch failed')`
 *  with the real undici cause in `err.cause`). */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Eager match: every fetch() transport failure has this message.
  // (4xx/5xx don't throw fetch-failed — they return a valid Response.)
  // The matching `err.name === 'TypeError'` makes the fetch origin
  // explicit so a rethrow elsewhere can't accidentally flip us to
  // retrying application errors that happen to share the phrase.
  if (err.name === 'TypeError' && err.message === 'fetch failed') return true;
  const code = ((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code ?? null);
  if (typeof code === 'string') {
    if (code.startsWith('UND_ERR_')) return true;
    if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  }
  const name = (err as { name?: string }).name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  // The underlying undici error is wrapped in err.cause for fetch-failed.
  // Inspect its name/code so retries fire on ConnectTimeoutError etc.
  const cause = (err as { cause?: { name?: string; code?: string } }).cause;
  if (cause) {
    const causeName = cause.name;
    if (causeName === 'TimeoutError' || causeName === 'AbortError' || causeName === 'ConnectTimeoutError') return true;
    if (typeof cause.code === 'string') {
      if (cause.code.startsWith('UND_ERR_')) return true;
      if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(cause.code)) return true;
    }
  }
  return false;
}

/** Default per-request timeout (the AbortSignal.timeout budget).
 *  Generous enough for slow CDN responses but tight enough that a
 *  dead connection doesn't hang the workflow for hours. Exported so
 *  pipeline/run.ts can share the same env-var knob (MEDSEARCH_FETCH_TIMEOUT_MS). */
export const DEFAULT_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.MEDSEARCH_FETCH_TIMEOUT_MS ?? '60000',
  10,
);

/**
 * Wrapper that retries transient thunks with exponential backoff. Used to
 * absorb transport-level errors from the BC government CDN (UND_ERR_SOCKET,
 * ECONNRESET, mid-stream TCP drops, ConnectTimeoutError, flaky 5xx) without
 * rewriting every call site.
 *
 * Defaults: 5 attempts, exponential backoff 1s → 16s (sum 31s of waiting).
 * Worst-case total time before giving up: 2 min of retries + the operation's
 * internal AbortSignal timeout per attempt. Inside the 90-min workflow
 * budget with room to spare.
 *
 * Retries ONLY transient transport errors. Non-transient errors (4xx/5xx,
 * regex no-match assertions) bubble immediately so we don't burn CI minutes
 * retrying purely structural problems.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  tag: string,
  maxRetries = 5,
  initialDelayMs = 1000,
  factor = 2,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (err: unknown) {
      const isLast = attempt > maxRetries;
      const transient = isTransientNetworkError(err);
      if (isLast || !transient) throw err;
      const delayMs = initialDelayMs * Math.pow(factor, attempt - 1);
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code
        ?? (err as { cause?: { code?: string } }).cause?.code
        ?? (err as { name?: string }).name
        ?? '-';
      // Surface the inner undici cause so a GHA run log shows the
      // real reason for the retry (e.g. ConnectTimeoutError /
      // UND_ERR_SOCKET) instead of a generic `TypeError: fetch failed`
      // whose root is buried in err.cause.
      const cause = (err as { cause?: { name?: string; message?: string; code?: string } }).cause;
      const causeInfo = cause
        ? ` cause=${cause.name ?? '?'} ${cause.code ?? '-'} ${(cause.message ?? '').slice(0, 60)}`
        : '';
      console.warn(
        `[retry] ${tag} transient ${code}. attempt ${attempt}/${maxRetries} → retrying in ${delayMs}ms (msg: ${message.slice(0, 80)}${causeInfo})`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Unreachable');
}

async function downloadTo(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  // withRetry covers both the initial fetch (UND_ERR_CONNECT_TIMEOUT
  // observed in GH Actions on gov.bc.ca) and any mid-stream TCP drop
  // during the body pipeline. Explicit AbortSignal.timeout budgets well
  // over undici's 10s default — gov.bc.ca responses can be slow under
  // load without indicating an error.
  await withRetry(async () => {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'MedSearch/0.1 (+https://github.com/buffy/medsearch)',
        accept: '*/*',
      },
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
