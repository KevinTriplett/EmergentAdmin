import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import type { Page } from 'puppeteer';

import {
  collectActiveMemberList,
  toCsvRow,
  type CollectActiveMemberListResult,
} from '../src/tasks/collectActiveMemberList.js';
import {
  activeMembersCsvPath,
  tokensMatch,
} from '../src/utils/activeMemberList.js';
import { loginIfNeeded } from '../src/auth.js';
import { createApp } from '../src/server.js';

vi.mock('../src/auth.js', () => ({
  loginIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('toCsvRow', () => {
  it('emits a clean comma-joined row when no field needs quoting', () => {
    expect(toCsvRow(['Jane Doe', '12345', '2025-04-19', '2026-05-01']))
      .toBe('Jane Doe,12345,2025-04-19,2026-05-01');
  });

  it('quotes named-month dates because they contain a comma', () => {
    /* MN's default rendering "Apr 19, 2026" has an embedded comma, so
     * the field must be wrapped in double quotes to round-trip
     * cleanly through any RFC-4180 reader. */
    expect(toCsvRow(['Jane Doe', '12345', 'Apr 19, 2025', 'May 1, 2026']))
      .toBe('Jane Doe,12345,"Apr 19, 2025","May 1, 2026"');
  });

  it('quotes fields containing a comma', () => {
    /* "Smith, Jane" contains a literal comma — without quoting, the CSV
     * would split it across two columns. */
    const row = toCsvRow(['Smith, Jane', '999']);
    expect(row).toBe('"Smith, Jane",999');
  });

  it('quotes fields containing a double-quote and doubles the inner quote', () => {
    const row = toCsvRow(['She said "hi"', '1']);
    expect(row).toBe('"She said ""hi""",1');
  });

  it('quotes fields containing a newline', () => {
    const row = toCsvRow(['line1\nline2', '1']);
    expect(row).toBe('"line1\nline2",1');
  });

  it('quotes fields containing a carriage return', () => {
    const row = toCsvRow(['line1\r\nline2', '1']);
    expect(row).toBe('"line1\r\nline2",1');
  });

  it('preserves leading/trailing spaces verbatim (caller already trimmed)', () => {
    const row = toCsvRow(['  edge  ', '1']);
    expect(row).toBe('  edge  ,1');
  });
});

describe('tokensMatch', () => {
  it('matches identical tokens', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
  });

  it('rejects mismatched tokens of equal length', () => {
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
  });

  it('rejects mismatched lengths without throwing', () => {
    /* `crypto.timingSafeEqual` would throw on length mismatch; the
     * helper must fall back to a non-throwing length check first. */
    expect(tokensMatch('short', 'a-much-longer-string')).toBe(false);
  });

  it('rejects empty inputs on either side', () => {
    expect(tokensMatch('', 'abc')).toBe(false);
    expect(tokensMatch('abc', '')).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
  });

  it('handles utf-8 byte sequences correctly', () => {
    expect(tokensMatch('café', 'café')).toBe(true);
    expect(tokensMatch('café', 'cafe')).toBe(false);
  });
});

describe('activeMembersCsvPath', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.ACTIVE_MEMBER_LIST_PATH;
    delete process.env.ACTIVE_MEMBER_LIST_PATH;
  });
  afterEach(() => {
    if (typeof original === 'string') process.env.ACTIVE_MEMBER_LIST_PATH = original;
    else delete process.env.ACTIVE_MEMBER_LIST_PATH;
  });

  it('defaults to <cwd>/data/active-members.csv', () => {
    expect(activeMembersCsvPath()).toBe(path.join(process.cwd(), 'data', 'active-members.csv'));
  });

  it('honours the ACTIVE_MEMBER_LIST_PATH override', () => {
    process.env.ACTIVE_MEMBER_LIST_PATH = '/tmp/custom-members.csv';
    expect(activeMembersCsvPath()).toBe('/tmp/custom-members.csv');
  });
});

// ---------------------------------------------------------------------------
// Task module (mocked Page)
// ---------------------------------------------------------------------------

/* Wire-shape of one element in MN's `/api/web/v1/spaces/<id>/members/all`
 * response array. The response IS the array — there is no envelope.
 * Only the fields we actually map are typed strictly; the API ships
 * many more we ignore. */
type ApiMember = {
  user: {
    id: number;
    name: string;
    email?: string;
    network_last_visit_at: string | null;
    membership: { created_at: string };
  };
  title: string;
  result_type: 'user';
  id: string;
};

/* The task's only `page.evaluate` call returns this discriminated union
 * — modelled to match the real fetch wrapper (`if (!r.ok) return { ok:
 * false, status }; return { ok: true, json }`). The mock doesn't run
 * the evaluate body in a browser; it simply hands back the canned
 * response that real fetch would have produced. */
type FetchResponse =
  | { ok: true; json: ApiMember[] }
  | { ok: false; status: number };

/**
 * Build a fully-scripted Page mock. The new task only calls
 * `page.evaluate` once per API page (the fetch wrapper), so the script
 * is just one `FetchResponse` per expected page. Other Puppeteer
 * primitives (`goto`, `waitForSelector`, `setViewport`) are noop-mocked.
 */
function buildPageWithFetchResponses(responses: readonly FetchResponse[]): Page {
  let i = 0;
  const evaluate = (..._args: unknown[]) => {
    if (i >= responses.length) {
      throw new Error(
        `evaluate() called more times than scripted (${i + 1} > ${responses.length})`,
      );
    }
    const r = responses[i++];
    return Promise.resolve(r);
  };
  return {
    setViewport: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(evaluate as never),
    screenshot: vi.fn().mockResolvedValue(undefined),
    $$: vi.fn().mockResolvedValue([]),
    $: vi.fn().mockResolvedValue(null),
    url: vi.fn().mockReturnValue('about:blank'),
    title: vi.fn().mockResolvedValue(''),
  } as unknown as Page;
}

describe('collectActiveMemberList', () => {
  const log = vi.fn<(m: string) => void | Promise<void>>().mockResolvedValue(undefined);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const fixedNow = new Date('2026-05-09T18:00:00Z');

  /** Days-ago helper that returns an ISO 8601 string with `Z` suffix
   * — matches the format of the live MN API. */
  function isoDaysAgo(days: number): string {
    return new Date(fixedNow.getTime() - days * 86_400_000).toISOString();
  }

  /** Build one ApiMember in the live API's wire shape. `lastActiveDaysAgo`
   * may be `null` to model the never-visited (network_last_visit_at: null)
   * case. */
  function makeMember({
    id,
    name,
    joinedDaysAgo,
    lastActiveDaysAgo,
  }: {
    id: number;
    name?: string;
    joinedDaysAgo: number;
    lastActiveDaysAgo: number | null;
  }): ApiMember {
    const display = name ?? `Member ${id}`;
    return {
      user: {
        id,
        name: display,
        email: `${id}@example.com`,
        network_last_visit_at: lastActiveDaysAgo === null ? null : isoDaysAgo(lastActiveDaysAgo),
        membership: { created_at: isoDaysAgo(joinedDaysAgo) },
      },
      title: display,
      result_type: 'user',
      id: `user_${id}`,
    };
  }

  let tmpDir: string;
  let outputPath: string;

  beforeEach(async () => {
    log.mockClear();
    sleep.mockClear();
    vi.mocked(loginIfNeeded).mockClear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-members-test-'));
    outputPath = path.join(tmpDir, 'active-members.csv');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Validation / abort short-circuits
  // -------------------------------------------------------------------------

  it('short-circuits with abort result when aborted before any browser work', async () => {
    const page = buildPageWithFetchResponses([]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: true },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result).toEqual({
      success: true,
      written: 0,
      skipped: 0,
      scanned: 0,
      error: 'Aborted by user',
    });
    expect(loginIfNeeded).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('writes a CSV from a single API page of active members', async () => {
    const members = [
      makeMember({ id: 111, name: 'Alice Anderson', joinedDaysAgo: 800, lastActiveDaysAgo: 5 }),
      makeMember({ id: 222, name: 'Bob Brown', joinedDaysAgo: 500, lastActiveDaysAgo: 30 }),
    ];
    const page = buildPageWithFetchResponses([
      { ok: true, json: members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(true);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.scanned).toBe(2);
    expect(result.outputPath).toBe(outputPath);

    const csv = await fs.readFile(outputPath, 'utf8');
    expect(csv.split('\n')[0]).toBe('NAME,MEMBER ID,JOINED,LAST ACTIVE');
    expect(csv).toContain('Alice Anderson,111');
    expect(csv).toContain('Bob Brown,222');
  });

  // -------------------------------------------------------------------------
  // Pagination termination
  // -------------------------------------------------------------------------

  it('paginates across multiple pages until a short page signals end', async () => {
    /* Page 1 has the per_page maximum of 100 active rows; page 2 has 50.
     * The task should walk both pages then stop because page 2 is
     * short. All 150 members are tenured + active in last 30 days. */
    const page1Members = Array.from({ length: 100 }, (_, i) =>
      makeMember({ id: 1000 + i, joinedDaysAgo: 800, lastActiveDaysAgo: 5 }),
    );
    const page2Members = Array.from({ length: 50 }, (_, i) =>
      makeMember({ id: 2000 + i, joinedDaysAgo: 800, lastActiveDaysAgo: 30 }),
    );
    const page = buildPageWithFetchResponses([
      { ok: true, json: page1Members },
      { ok: true, json: page2Members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(true);
    expect(result.written).toBe(150);
    expect(result.skipped).toBe(0);
    expect(result.scanned).toBe(150);
    expect(vi.mocked(page.evaluate)).toHaveBeenCalledTimes(2);
  });

  it('paginates until an empty page is returned', async () => {
    const page1Members = Array.from({ length: 100 }, (_, i) =>
      makeMember({ id: 1000 + i, joinedDaysAgo: 800, lastActiveDaysAgo: 5 }),
    );
    const page = buildPageWithFetchResponses([
      { ok: true, json: page1Members },
      { ok: true, json: [] },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(true);
    expect(result.written).toBe(100);
    expect(result.scanned).toBe(100);
    expect(vi.mocked(page.evaluate)).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Filter logic — happy variants
  // -------------------------------------------------------------------------

  it('skips recent joiners (joined < 1 year ago) and continues the walk', async () => {
    const members = [
      makeMember({ id: 111, name: 'Tenured Alice', joinedDaysAgo: 800, lastActiveDaysAgo: 5 }),
      makeMember({ id: 222, name: 'New Bob', joinedDaysAgo: 180, lastActiveDaysAgo: 2 }),
      makeMember({ id: 333, name: 'Tenured Carol', joinedDaysAgo: 800, lastActiveDaysAgo: 25 }),
    ];
    const page = buildPageWithFetchResponses([
      { ok: true, json: members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(true);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.scanned).toBe(3);

    const csv = await fs.readFile(outputPath, 'utf8');
    expect(csv).toContain('Tenured Alice,111');
    expect(csv).toContain('Tenured Carol,333');
    expect(csv).not.toContain('New Bob');
  });

  it('breaks at first row whose lastActive > 30 days ago and discards it', async () => {
    /* Stale Bob is the break trigger. Per the spec, scanned counts only
     * rows that survived classification (kept + skipped); the breaking
     * row itself is NOT counted. So scanned = 1 (just Active Alice). */
    const members = [
      makeMember({ id: 111, name: 'Active Alice', joinedDaysAgo: 800, lastActiveDaysAgo: 20 }),
      makeMember({ id: 222, name: 'Stale Bob', joinedDaysAgo: 800, lastActiveDaysAgo: 31 }),
      makeMember({ id: 333, name: 'Should Not See', joinedDaysAgo: 800, lastActiveDaysAgo: 35 }),
    ];
    const page = buildPageWithFetchResponses([
      { ok: true, json: members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(true);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.scanned).toBe(1);

    const csv = await fs.readFile(outputPath, 'utf8');
    expect(csv).toContain('Active Alice');
    expect(csv).not.toContain('Stale Bob');
    expect(csv).not.toContain('Should Not See');
  });

  // -------------------------------------------------------------------------
  // Boundary precision (per system_prompt §3.4)
  // -------------------------------------------------------------------------

  it('keeps a row whose lastActive is exactly 30 days old (inclusive cutoff)', async () => {
    const members = [
      makeMember({ id: 111, name: 'Edge Alice', joinedDaysAgo: 800, lastActiveDaysAgo: 30 }),
    ];
    const page = buildPageWithFetchResponses([
      { ok: true, json: members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('keeps a row whose joined is exactly 1 year old (inclusive cutoff)', async () => {
    const members = [
      makeMember({ id: 111, name: 'Edge Alice', joinedDaysAgo: 365, lastActiveDaysAgo: 1 }),
    ];
    const page = buildPageWithFetchResponses([
      { ok: true, json: members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Empty-list paths
  // -------------------------------------------------------------------------

  it('writes a header-only CSV when API returns an empty first page', async () => {
    const page = buildPageWithFetchResponses([
      { ok: true, json: [] },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });
    expect(result.success).toBe(true);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.scanned).toBe(0);

    const csv = await fs.readFile(outputPath, 'utf8');
    expect(csv).toBe('NAME,MEMBER ID,JOINED,LAST ACTIVE\n');
  });

  // -------------------------------------------------------------------------
  // Null sentinel break (never-visited)
  // -------------------------------------------------------------------------

  it('breaks at a row whose network_last_visit_at is null (never-visited)', async () => {
    /* Same scanned semantics as the inactive break: the breaking row
     * (Never Bob) is examined but does not count toward scanned. So
     * scanned = 1 (Active Alice). */
    const members = [
      makeMember({ id: 111, name: 'Active Alice', joinedDaysAgo: 800, lastActiveDaysAgo: 30 }),
      makeMember({ id: 222, name: 'Never Bob', joinedDaysAgo: 800, lastActiveDaysAgo: null }),
      makeMember({ id: 333, name: 'Should Not See', joinedDaysAgo: 800, lastActiveDaysAgo: 5 }),
    ];
    const page = buildPageWithFetchResponses([
      { ok: true, json: members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(true);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.scanned).toBe(1);

    const csv = await fs.readFile(outputPath, 'utf8');
    expect(csv).toContain('Active Alice');
    expect(csv).not.toContain('Never Bob');
    expect(csv).not.toContain('Should Not See');
  });

  // -------------------------------------------------------------------------
  // HTTP failure
  // -------------------------------------------------------------------------

  it('fails with HTTP error when API returns non-200', async () => {
    const page = buildPageWithFetchResponses([
      { ok: false, status: 500 },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
    /* No CSV is written when the API fetch fails — preserves any
     * previously-good file on disk for the operator to fall back to. */
    await expect(fs.access(outputPath)).rejects.toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Excluded members (bot account)
  // -------------------------------------------------------------------------

  it('excludes id 39358139 from the CSV without ending pagination', async () => {
    /* The Commons Keeper Admin (id 39358139) is the bot account this
     * scraper logs in as. Without the exclusion it always tops the
     * sort because it just updated its own network_last_visit_at on
     * login. The classifier returns kind:'skip', reason:'excluded' for
     * this id — counts toward `skipped`, never breaks the walk. */
    const members = [
      makeMember({ id: 111, name: 'Alice Anderson', joinedDaysAgo: 800, lastActiveDaysAgo: 1 }),
      makeMember({ id: 39358139, name: 'Commons Keeper Admin', joinedDaysAgo: 800, lastActiveDaysAgo: 5 }),
      makeMember({ id: 333, name: 'Carol Carter', joinedDaysAgo: 800, lastActiveDaysAgo: 30 }),
    ];
    const page = buildPageWithFetchResponses([
      { ok: true, json: members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(true);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.scanned).toBe(3);

    const csv = await fs.readFile(outputPath, 'utf8');
    expect(csv).toContain('Alice Anderson,111');
    expect(csv).toContain('Carol Carter,333');
    expect(csv).not.toContain('39358139');
    expect(csv).not.toContain('Commons Keeper Admin');
  });

  // -------------------------------------------------------------------------
  // Sort sanity check
  // -------------------------------------------------------------------------

  it('logs a warning when a page is not sorted descending by last_visit_at', async () => {
    /* MN's API is documented to honour `sort=last_visit_at&sort_order=desc`,
     * but the task probes each page's actual ordering as insurance. A
     * violation is log-only and does not abort the run — the operator
     * gets a noisy warning so they notice if MN ever silently changes
     * the contract. */
    const members = [
      makeMember({ id: 111, name: 'Older Alice', joinedDaysAgo: 800, lastActiveDaysAgo: 30 }),
      makeMember({ id: 222, name: 'Newer Bob', joinedDaysAgo: 800, lastActiveDaysAgo: 5 }),
    ];
    const page = buildPageWithFetchResponses([
      { ok: true, json: members },
    ]);

    const result = await collectActiveMemberList({
      page,
      log,
      abortSignal: { aborted: false },
      sleep,
      outputPath,
      now: fixedNow,
    });

    expect(result.success).toBe(true);
    const logCalls = log.mock.calls.map((args) => String(args[0])).join('\n');
    expect(logCalls).toMatch(/WARNING.*sort/i);
  });
});

// ---------------------------------------------------------------------------
// Server endpoints
// ---------------------------------------------------------------------------

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, () => resolve());
    server.once('error', reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('server endpoints — collect-active-member-list', () => {
  const launchBrowser = vi.fn();
  const removeSpaceMembers = vi.fn();
  const addSpaceMember = vi.fn();
  const collectActiveMemberListMock =
    vi.fn<() => Promise<CollectActiveMemberListResult>>();

  let tmpDir: string;
  let csvPath: string;
  let originalToken: string | undefined;
  let originalPath: string | undefined;

  beforeEach(async () => {
    launchBrowser.mockReset();
    removeSpaceMembers.mockReset();
    addSpaceMember.mockReset();
    collectActiveMemberListMock.mockReset();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-srv-test-'));
    csvPath = path.join(tmpDir, 'active-members.csv');
    originalToken = process.env.ACTIVE_MEMBER_LIST_TOKEN;
    originalPath = process.env.ACTIVE_MEMBER_LIST_PATH;
    process.env.ACTIVE_MEMBER_LIST_PATH = csvPath;
  });

  afterEach(async () => {
    if (typeof originalToken === 'string') {
      process.env.ACTIVE_MEMBER_LIST_TOKEN = originalToken;
    } else {
      delete process.env.ACTIVE_MEMBER_LIST_TOKEN;
    }
    if (typeof originalPath === 'string') {
      process.env.ACTIVE_MEMBER_LIST_PATH = originalPath;
    } else {
      delete process.env.ACTIVE_MEMBER_LIST_PATH;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // POST /run/collect-active-member-list
  // -------------------------------------------------------------------------

  it('POST /run/collect-active-member-list returns 404 when the task is not wired', async () => {
    /* Existing tests that call createApp without `collectActiveMemberList`
     * should not start failing because of this feature. The endpoint
     * gracefully returns 404 rather than throwing. */
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/collect-active-member-list')
        .send({ headless: true });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not wired/i);
    } finally {
      await closeServer(server);
    }
  });

  it('POST /run/collect-active-member-list returns 200 with the task result', async () => {
    collectActiveMemberListMock.mockResolvedValueOnce({
      success: true,
      written: 7,
      skipped: 2,
      scanned: 10,
      outputPath: csvPath,
    });
    launchBrowser.mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        setUserAgent: vi.fn().mockResolvedValue(undefined),
        setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue('about:blank'),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      collectActiveMemberList: collectActiveMemberListMock as never,
    });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/collect-active-member-list')
        .send({ headless: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        written: 7,
        skipped: 2,
        scanned: 10,
        outputPath: csvPath,
      });
      expect(collectActiveMemberListMock).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });

  it('POST /run/collect-active-member-list rejects non-boolean headless with 400', async () => {
    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      collectActiveMemberList: collectActiveMemberListMock as never,
    });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/collect-active-member-list')
        .send({ headless: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/headless must be a boolean/);
      expect(launchBrowser).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  // -------------------------------------------------------------------------
  // GET /downloads/active-members-link
  // -------------------------------------------------------------------------

  it('GET /downloads/active-members-link returns 404 when the token is unset', async () => {
    delete process.env.ACTIVE_MEMBER_LIST_TOKEN;
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).get('/downloads/active-members-link');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/ACTIVE_MEMBER_LIST_TOKEN/);
    } finally {
      await closeServer(server);
    }
  });

  it('GET /downloads/active-members-link returns exists:false when no CSV is on disk', async () => {
    process.env.ACTIVE_MEMBER_LIST_TOKEN = 'test-token';
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).get('/downloads/active-members-link');
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(false);
      expect(res.body.mtime).toBeNull();
      expect(res.body.url).toBe('/downloads/active-members.csv?token=test-token');
    } finally {
      await closeServer(server);
    }
  });

  it('GET /downloads/active-members-link returns exists:true + mtime when CSV is present', async () => {
    process.env.ACTIVE_MEMBER_LIST_TOKEN = 'test-token';
    await fs.writeFile(csvPath, 'NAME,MEMBER ID,JOINED,LAST ACTIVE\n');

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).get('/downloads/active-members-link');
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(true);
      expect(res.body.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await closeServer(server);
    }
  });

  // -------------------------------------------------------------------------
  // GET /downloads/active-members.csv
  // -------------------------------------------------------------------------

  it('GET /downloads/active-members.csv returns 404 when the token is unset', async () => {
    delete process.env.ACTIVE_MEMBER_LIST_TOKEN;
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .get('/downloads/active-members.csv')
        .query({ token: 'anything' });
      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('GET /downloads/active-members.csv returns 403 on token mismatch', async () => {
    process.env.ACTIVE_MEMBER_LIST_TOKEN = 'expected-token';
    await fs.writeFile(csvPath, 'NAME,MEMBER ID,JOINED,LAST ACTIVE\n');

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .get('/downloads/active-members.csv')
        .query({ token: 'wrong-token' });
      expect(res.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it('GET /downloads/active-members.csv returns 404 when the file is missing even with valid token', async () => {
    process.env.ACTIVE_MEMBER_LIST_TOKEN = 'expected-token';
    /* csvPath does not exist */

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .get('/downloads/active-members.csv')
        .query({ token: 'expected-token' });
      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('GET /downloads/active-members.csv streams the file with correct headers on success', async () => {
    process.env.ACTIVE_MEMBER_LIST_TOKEN = 'expected-token';
    const csvBody = 'NAME,MEMBER ID,JOINED,LAST ACTIVE\nAlice,111,Apr 19, 2025,Apr 1, 2026\n';
    await fs.writeFile(csvPath, csvBody);

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .get('/downloads/active-members.csv')
        .query({ token: 'expected-token' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment.*active-members\.csv/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toBe(csvBody);
    } finally {
      await closeServer(server);
    }
  });
});
