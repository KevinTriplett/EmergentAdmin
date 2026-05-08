import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dumpFailureDiagnostics } from '../src/utils/diagnostics.js';

/* Minimal page stand-in. Real Puppeteer pages can fail in lots of subtle
 * ways during diagnostics (closed targets, detached frames, mid-nav state),
 * so the helper is contract-bound to swallow ALL of those. These tests
 * exercise that contract with hand-rolled fakes instead of a real browser
 * — the goal is to prove the swallow guarantee, not to validate Puppeteer
 * itself. */
type FakePage = {
  url: () => string;
  title: () => Promise<string>;
  evaluate: (...args: unknown[]) => Promise<unknown>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<void>;
};

function makeHappyPage(opts: { url?: string; title?: string; bodyClass?: string } = {}): FakePage {
  return {
    url: () => opts.url ?? 'https://example.com/some/page',
    title: async () => opts.title ?? 'Example Page',
    evaluate: async () => opts.bodyClass ?? 'communities-app pace-done',
    screenshot: async ({ path: p }) => {
      const tinyPng = Buffer.from(
        '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
        'hex',
      );
      await fs.writeFile(p, tinyPng);
    },
  };
}

describe('dumpFailureDiagnostics', () => {
  let tmpDir: string;
  let originalDumpDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-dump-test-'));
    originalDumpDir = process.env.DIAG_DUMP_DIR;
    process.env.DIAG_DUMP_DIR = tmpDir;
  });

  afterEach(async () => {
    if (typeof originalDumpDir === 'string') {
      process.env.DIAG_DUMP_DIR = originalDumpDir;
    } else {
      delete process.env.DIAG_DUMP_DIR;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes both PNG and JSON for the happy path and returns their paths', async () => {
    const page = makeHappyPage({
      url: 'https://emergent-commons.mn.co/spaces/5285007/admin/members/all',
      title: 'Just a moment...',
      bodyClass: 'cf-challenge',
    });
    const logs: string[] = [];

    const result = await dumpFailureDiagnostics(
      page as never,
      {
        reason: 'add-space-member-failed',
        fullMemberName: 'James Baker',
        memberId: '12345',
        fullSpaceName: '5. News/Ideas from Crews, Teams, Events',
        error: new Error('Navigation timeout of 30000 ms exceeded'),
      },
      (m) => logs.push(m),
    );

    expect(result.pngPath).not.toBeNull();
    expect(result.jsonPath).not.toBeNull();
    await expect(fs.access(result.pngPath!)).resolves.toBeUndefined();

    const meta = JSON.parse(await fs.readFile(result.jsonPath!, 'utf8'));
    expect(meta.reason).toBe('add-space-member-failed');
    expect(meta.memberId).toBe('12345');
    expect(meta.fullSpaceName).toBe('5. News/Ideas from Crews, Teams, Events');
    expect(meta.page.url).toBe('https://emergent-commons.mn.co/spaces/5285007/admin/members/all');
    expect(meta.page.title).toBe('Just a moment...');
    expect(meta.page.bodyClass).toBe('cf-challenge');
    expect(meta.error.message).toBe('Navigation timeout of 30000 ms exceeded');
    expect(meta.screenshot).toBe(result.pngPath);

    expect(logs.some((m) => m.startsWith('[diag] dumped failure context'))).toBe(true);
  });

  it('produces filenames that contain the reason and a sortable timestamp prefix', async () => {
    const page = makeHappyPage();
    const result = await dumpFailureDiagnostics(
      page as never,
      {
        reason: 'add-space-member-failed',
        memberId: '99',
        fullSpaceName: 'Some Space',
        error: new Error('boom'),
      },
      () => {},
    );

    const base = path.basename(result.pngPath!);
    expect(base).toMatch(/^\d{8}T\d{6}Z-add-space-member-failed-99-Some-Space\.png$/);
  });

  it('still writes a JSON file when no page is provided', async () => {
    const result = await dumpFailureDiagnostics(
      null,
      {
        reason: 'add-space-member-failed',
        memberId: 'no-page',
        fullSpaceName: 'whatever',
        error: 'string-error',
      },
      () => {},
    );

    expect(result.pngPath).toBeNull();
    expect(result.jsonPath).not.toBeNull();
    const meta = JSON.parse(await fs.readFile(result.jsonPath!, 'utf8'));
    expect(meta.page).toEqual({ url: null, title: null, bodyClass: null });
    expect(meta.error.message).toBe('string-error');
    expect(meta.screenshot).toBeNull();
  });

  it('captures the full error.cause chain so wrapped errors do not hide the real cause', async () => {
    /* This is the exact shape produced by `auth.ts`'s login() catch:
     * a generic "Login failed" wrapping a real TimeoutError. Without
     * cause-chain support the dump would say only "Login failed"
     * and we'd miss the actual root cause. */
    const realCause = new Error('Navigation timeout of 30000 ms exceeded');
    realCause.name = 'TimeoutError';
    const wrapped = new Error('Login failed — check credentials or MN_COMMUNITY_URL in .env', {
      cause: realCause,
    });

    const result = await dumpFailureDiagnostics(
      makeHappyPage() as never,
      {
        reason: 'add-space-member-failed',
        memberId: '12345',
        fullSpaceName: 'Some Space',
        error: wrapped,
      },
      () => {},
    );

    const meta = JSON.parse(await fs.readFile(result.jsonPath!, 'utf8'));
    expect(meta.error.message).toBe('Login failed — check credentials or MN_COMMUNITY_URL in .env');
    expect(meta.error.cause).toBeDefined();
    expect(meta.error.cause.name).toBe('TimeoutError');
    expect(meta.error.cause.message).toBe('Navigation timeout of 30000 ms exceeded');
    /* No further nesting on the inner cause. */
    expect(meta.error.cause.cause).toBeUndefined();
  });

  it('caps cause-chain depth so a pathological chain cannot run away', async () => {
    /* Build a 20-deep chain. The serializer must terminate well
     * before that — both as a runaway guard and so the JSON file
     * stays a sane size. */
    let head: Error = new Error('innermost');
    for (let i = 0; i < 20; i += 1) {
      head = new Error(`level-${i}`, { cause: head });
    }

    const result = await dumpFailureDiagnostics(
      makeHappyPage() as never,
      {
        reason: 'add-space-member-failed',
        memberId: '13',
        fullSpaceName: 'Space',
        error: head,
      },
      () => {},
    );

    const meta = JSON.parse(await fs.readFile(result.jsonPath!, 'utf8'));
    let depth = 0;
    let node = meta.error;
    while (node?.cause) {
      depth += 1;
      node = node.cause;
    }
    expect(depth).toBeLessThanOrEqual(8);
  });

  it('still writes JSON when the screenshot throws (e.g. target closed)', async () => {
    const page: FakePage = {
      ...makeHappyPage(),
      screenshot: async () => {
        throw new Error('Protocol error: Target closed.');
      },
    };
    const logs: string[] = [];

    const result = await dumpFailureDiagnostics(
      page as never,
      {
        reason: 'add-space-member-failed',
        memberId: '7',
        fullSpaceName: 'Space',
        error: new Error('orig'),
      },
      (m) => logs.push(m),
    );

    expect(result.pngPath).toBeNull();
    expect(result.jsonPath).not.toBeNull();
    expect(logs.some((m) => m.includes('screenshot failed') && m.includes('Target closed'))).toBe(true);
  });

  it('captures partial page state when individual probes throw', async () => {
    const page: FakePage = {
      url: () => 'https://example.com/known',
      title: async () => {
        throw new Error('detached frame');
      },
      evaluate: async () => {
        throw new Error('Execution context was destroyed');
      },
      screenshot: makeHappyPage().screenshot,
    };

    const result = await dumpFailureDiagnostics(
      page as never,
      {
        reason: 'add-space-member-failed',
        memberId: '8',
        fullSpaceName: 'Space',
        error: new Error('outer'),
      },
      () => {},
    );

    const meta = JSON.parse(await fs.readFile(result.jsonPath!, 'utf8'));
    expect(meta.page.url).toBe('https://example.com/known');
    expect(meta.page.title).toBeNull();
    expect(meta.page.bodyClass).toBeNull();
  });

  it('never throws when the dump dir is unwritable', async () => {
    /* Point at a path whose parent is a *file*, so mkdir will reject.
     * That tickles the outermost catch-all. */
    const blockingFile = path.join(tmpDir, 'blocker');
    await fs.writeFile(blockingFile, 'x');
    process.env.DIAG_DUMP_DIR = path.join(blockingFile, 'sub');

    const logs: string[] = [];
    const result = await dumpFailureDiagnostics(
      makeHappyPage() as never,
      {
        reason: 'add-space-member-failed',
        memberId: '9',
        fullSpaceName: 'Space',
        error: new Error('outer'),
      },
      (m) => logs.push(m),
    );

    expect(result.pngPath).toBeNull();
    expect(result.jsonPath).toBeNull();
    expect(logs.some((m) => m.startsWith('[diag] failed to dump diagnostics'))).toBe(true);
  });

  it('never throws when the log function itself throws', async () => {
    const blockingFile = path.join(tmpDir, 'blocker2');
    await fs.writeFile(blockingFile, 'x');
    process.env.DIAG_DUMP_DIR = path.join(blockingFile, 'sub');

    /* Combination of unwritable dir + throwing log. The helper's
     * contract is that even this case returns normally. */
    await expect(
      dumpFailureDiagnostics(
        makeHappyPage() as never,
        {
          reason: 'add-space-member-failed',
          memberId: '10',
          fullSpaceName: 'Space',
          error: new Error('outer'),
        },
        () => {
          throw new Error('logger blew up');
        },
      ),
    ).resolves.toEqual({ pngPath: null, jsonPath: null });
  });

  it('uses the default dump dir when DIAG_DUMP_DIR is empty/whitespace', async () => {
    process.env.DIAG_DUMP_DIR = '   ';
    /* Move CWD to tmpDir so the default "data/diagnostics" lands inside it,
     * not in the project tree where it would pollute the workspace. */
    const oldCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = await dumpFailureDiagnostics(
        makeHappyPage() as never,
        {
          reason: 'add-space-member-failed',
          memberId: '11',
          fullSpaceName: 'Space',
          error: new Error('outer'),
        },
        () => {},
      );
      expect(result.jsonPath).not.toBeNull();
      expect(result.jsonPath!.replace(/\\/g, '/')).toContain('data/diagnostics/');
    } finally {
      process.chdir(oldCwd);
    }
  });
});
