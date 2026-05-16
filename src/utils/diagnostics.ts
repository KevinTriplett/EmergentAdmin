import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Page } from 'puppeteer';

/**
 * Failure-diagnostics dumper.
 *
 * Writes a PNG screenshot + a small JSON metadata file when a Puppeteer
 * task fails, so the operator can see exactly what page Mighty Networks
 * (or Cloudflare in front of it) was serving at the moment of failure.
 *
 * The dumper is non-fatal-by-design: every step (resolving the dir,
 * collecting page state, taking the screenshot, writing files) is
 * wrapped so a diagnostics failure can never mask the original error
 * the caller is about to re-throw or return. Worst case we log a
 * warning and the caller continues.
 *
 * Output location is `DIAG_DUMP_DIR` (env), default `data/diagnostics`
 * under the working directory. `data/` is already gitignored project-
 * wide.
 *
 * Filenames are `${ISO timestamp}-${reason}-${memberSlug}-${spaceSlug}`
 * with `.png` and `.json` extensions for the same incident, so PNG and
 * JSON pairs sort together chronologically.
 */
export type DiagnosticsContext = {
  /**
   * Short stable label identifying which task / failure mode this dump
   * comes from. Examples: `'add-space-member-failed'`,
   * `'remove-space-members-failed'`. Used in filenames and logs so an
   * operator scanning the dump dir can tell at a glance what failed.
   */
  reason: string;
  fullMemberName?: string;
  memberId?: string;
  fullSpaceName?: string;
  /** The error that triggered the dump. Stringified for the JSON metadata. */
  error: unknown;
};

export type DiagnosticsResult = {
  pngPath: string | null;
  jsonPath: string | null;
};

const DEFAULT_DUMP_DIR = 'data/diagnostics';

function resolveDumpDir(): string {
  const env = process.env.DIAG_DUMP_DIR?.trim();
  return env && env.length > 0 ? env : DEFAULT_DUMP_DIR;
}

/* `2026-05-08T14:59:01.123Z` -> `20260508T145901Z`. The colons and the
 * fractional second are the parts shells don't love; we keep just date
 * + time + `Z` so the names sort lexicographically by occurrence. */
function fsTimestamp(date: Date = new Date()): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/* Build a filesystem-safe slug for arbitrary user input. The space
 * names contain spaces, slashes, dots, and commas; member IDs are
 * digits but we still cap length defensively. We replace any run of
 * non-[A-Za-z0-9] with a single dash, trim leading/trailing dashes,
 * and cap at 60 chars to keep filenames short. */
function slugify(value: string | undefined, fallback: string): string {
  const raw = (value ?? '').trim();
  if (raw === '') return fallback;
  const slug = raw
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug === '' ? fallback : slug;
}

/**
 * Recursively serialize an error and its `cause` chain. Without this,
 * a wrapped error like `new Error('Login failed', { cause: realErr })`
 * dumps only the misleading top-level message; the actual underlying
 * cause (e.g. a `TimeoutError: Navigation timeout`) is dropped on the
 * floor. The chain is bounded by `MAX_CAUSE_DEPTH` so a self-
 * referential or pathologically deep chain can't run away.
 */
type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
  cause?: SerializedError;
};

const MAX_CAUSE_DEPTH = 8;

function errorToJson(err: unknown, depth = 0): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
    /* `cause` is `unknown` per ES2022. We only recurse if depth is
     * still under the cap and the cause is non-nullish, so a chain of
     * `{ cause: undefined }` terminates cleanly. */
    if (depth < MAX_CAUSE_DEPTH && (err as { cause?: unknown }).cause != null) {
      out.cause = errorToJson((err as { cause?: unknown }).cause, depth + 1);
    }
    return out;
  }
  return { message: String(err) };
}

type PageState = {
  url: string | null;
  title: string | null;
  bodyClass: string | null;
  /**
   * `document.querySelectorAll('input').length` at capture time.
   * Discriminates the "form not yet mounted" race (bodyClass set but
   * inputCount === 0) from a markup change (inputCount > 0 but the
   * task's selectors miss). Null when the probe couldn't run.
   */
  inputCount: number | null;
};

/**
 * Best-effort extraction of identifying page state. Each field is
 * captured in its own try/catch because any of them can fail
 * independently when the page is mid-navigation, the execution
 * context was destroyed, or the target was closed.
 */
async function capturePageState(page: Page): Promise<PageState> {
  const state: PageState = { url: null, title: null, bodyClass: null, inputCount: null };
  try {
    state.url = page.url();
  } catch {
    /* page.url() shouldn't throw, but guard anyway. */
  }
  try {
    state.title = await page.title();
  } catch {
    /* page.title() can throw on detached frames. */
  }
  try {
    /* Single evaluate so bodyClass and inputCount come from the same
     * DOM snapshot (a separate round-trip could observe them at
     * different points in a re-render). */
    const probe = await page.evaluate(() => ({
      bodyClass: document.body?.className ?? '',
      inputCount: document.querySelectorAll('input').length,
    }));
    if (probe && typeof probe === 'object') {
      const typed = probe as { bodyClass?: unknown; inputCount?: unknown };
      if (typeof typed.bodyClass === 'string') state.bodyClass = typed.bodyClass;
      if (typeof typed.inputCount === 'number') state.inputCount = typed.inputCount;
    }
  } catch {
    /* Execution context destroyed during nav timeout, etc. */
  }
  return state;
}

/**
 * Write a screenshot + JSON metadata for a failed Puppeteer task.
 *
 * Returns the (best-effort) paths of what was actually written;
 * either field may be `null` if that artifact couldn't be produced.
 * Never throws.
 */
export async function dumpFailureDiagnostics(
  page: Page | null | undefined,
  ctx: DiagnosticsContext,
  log: (msg: string) => void | Promise<void>,
): Promise<DiagnosticsResult> {
  const result: DiagnosticsResult = { pngPath: null, jsonPath: null };

  try {
    const dumpDir = resolveDumpDir();
    await fs.mkdir(dumpDir, { recursive: true });

    const stem = [
      fsTimestamp(),
      slugify(ctx.reason, 'failure'),
      slugify(ctx.memberId, 'no-member'),
      slugify(ctx.fullSpaceName, 'no-space'),
    ].join('-');

    const pngPath = path.join(dumpDir, `${stem}.png`);
    const jsonPath = path.join(dumpDir, `${stem}.json`);

    let pageState: PageState = { url: null, title: null, bodyClass: null, inputCount: null };
    if (page) {
      pageState = await capturePageState(page);
      try {
        /* fullPage:false is intentional. The interesting evidence
         * (Cloudflare interstitial, login form, error toast) is
         * always above the fold; full-page captures can be huge
         * on infinite-scroll pages. */
        await page.screenshot({ path: pngPath, fullPage: false });
        result.pngPath = pngPath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await log(`[diag] screenshot failed: ${message}`);
      }
    }

    const metadata = {
      capturedAt: new Date().toISOString(),
      reason: ctx.reason,
      fullMemberName: ctx.fullMemberName ?? null,
      memberId: ctx.memberId ?? null,
      fullSpaceName: ctx.fullSpaceName ?? null,
      page: pageState,
      error: errorToJson(ctx.error),
      screenshot: result.pngPath,
    };

    try {
      await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
      result.jsonPath = jsonPath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await log(`[diag] metadata write failed: ${message}`);
    }

    if (result.pngPath || result.jsonPath) {
      await log(
        `[diag] dumped failure context: ${result.pngPath ?? '(no png)'} | ${result.jsonPath ?? '(no json)'}`,
      );
    }
  } catch (err) {
    /* Final catch-all so the helper truly cannot throw. */
    const message = err instanceof Error ? err.message : String(err);
    try {
      await log(`[diag] failed to dump diagnostics: ${message}`);
    } catch {
      /* If even logging throws, give up silently. */
    }
  }

  return result;
}
