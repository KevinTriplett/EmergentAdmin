import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'puppeteer';
import { createApp, resolveAuditCronExpr, resolveReconcileCronExpr } from '../src/server.js';
import { openAgreementsStore } from '../src/state/agreementsStore.js';
import type { PollResult } from '../src/ingestion/imapPoller.js';

const EMPTY_POLL_RESULT: PollResult = {
  fetched: 0,
  newAgreements: 0,
  duplicates: 0,
  addsQueued: 0,
  dmsQueued: 0,
  skipped: 0,
  errors: 0,
};

function postJson(
  server: Server,
  body: object,
  path = '/run/remove-space-members',
): Promise<{ status: number; json: unknown }> {
  const addr = server.address() as AddressInfo | string | null;
  if (!addr || typeof addr === 'string') {
    return Promise.reject(new Error('server not listening'));
  }
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

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

describe('createApp', () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const newPage = vi.fn();
  const launchBrowser = vi.fn();

  const removeSpaceMembers = vi.fn();
  const addSpaceMember = vi.fn();
  const sendRunLogEmail = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    close.mockClear();
    newPage.mockReset();
    launchBrowser.mockReset();
    removeSpaceMembers.mockReset();
    addSpaceMember.mockReset();
    sendRunLogEmail.mockClear();
  });

  function buildMockPage(): Page {
    return {
      setUserAgent: vi.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        userAgent: 'test-agent',
        platform: 'test-platform',
        language: 'en-US',
      }),
      url: vi.fn().mockReturnValue('about:blank'),
    } as unknown as Page;
  }

  it('returns 400 when fullSpaceName is missing', async () => {
    launchBrowser.mockRejectedValue(new Error('should not launch'));
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/remove-space-members').send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'fullSpaceName is required' });
      expect(launchBrowser).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('returns 400 when fullSpaceName is not a non-empty string', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/remove-space-members')
        .send({ fullSpaceName: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/fullSpaceName/i);
    } finally {
      await closeServer(server);
    }
  });

  it('returns 409 when a task is already running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    removeSpaceMembers.mockImplementationOnce(async () => {
      await gate;
      return { success: true, removed: 0 };
    });

    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const firstPromise = postJson(server, {
        fullSpaceName: 'Marketplace',
        headless: true,
        dryRun: true,
      });

      await expect.poll(() => removeSpaceMembers.mock.calls.length).toBeGreaterThan(0);

      const second = await postJson(server, { fullSpaceName: 'Marketplace' });
      expect(second.status).toBe(409);
      expect(second.json).toEqual({ error: 'A task is already running' });

      release();
      const firstRes = await firstPromise;
      expect(firstRes.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('returns 500 when browser launch fails', async () => {
    launchBrowser.mockRejectedValue(new Error('Chromium not found'));
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/remove-space-members').send({
        fullSpaceName: 'Marketplace',
      });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Chromium not found' });
    } finally {
      await closeServer(server);
    }
  });

  it('returns 200 with task result on success', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    removeSpaceMembers.mockResolvedValue({ success: true, removed: 0 });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/remove-space-members').send({
        fullSpaceName: 'Marketplace',
        dryRun: true,
        headless: true,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, removed: 0 });
      expect(launchBrowser).toHaveBeenCalledWith(true);
      expect(removeSpaceMembers).toHaveBeenCalledWith({
        page: mockPage,
        fullSpaceName: 'Marketplace',
        dryRun: true,
        log: expect.any(Function),
        abortSignal: { aborted: false },
        sleep: expect.any(Function),
      });
      expect(close).toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('defaults headless and dryRun to true when omitted', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    removeSpaceMembers.mockResolvedValue({ success: true, removed: 0 });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      await request(server).post('/run/remove-space-members').send({
        fullSpaceName: 'Marketplace',
      });

      expect(launchBrowser).toHaveBeenCalledWith(true);
      expect(removeSpaceMembers).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true }),
      );
    } finally {
      await closeServer(server);
    }
  });

  it('serves index.html on GET /', async () => {
    launchBrowser.mockRejectedValue(new Error('no'));
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('MN Host Automator');
    } finally {
      await closeServer(server);
    }
  });

  // -------------------------------------------------------------------------
  // POST /run/add-space-member (single space)
  // -------------------------------------------------------------------------

  it('returns 400 when fullMemberName is missing on add-space-member', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/add-space-member')
        .send({ memberId: '12345', fullSpaceName: 'Marketplace' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/fullMemberName/i);
      expect(addSpaceMember).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('returns 400 when memberId is missing on add-space-member', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/add-space-member')
        .send({ fullMemberName: 'Jane Doe', fullSpaceName: 'Marketplace' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/memberId/i);
    } finally {
      await closeServer(server);
    }
  });

  it('returns 400 when fullSpaceName is missing on add-space-member', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/add-space-member')
        .send({ fullMemberName: 'Jane Doe', memberId: '12345' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/fullSpaceName/i);
    } finally {
      await closeServer(server);
    }
  });

  it('returns 200 and passes through result on add-space-member success', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    addSpaceMember.mockResolvedValue({ success: true });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/add-space-member').send({
        fullMemberName: 'Jane Doe',
        memberId: '12345',
        fullSpaceName: 'Marketplace',
        headless: false,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(launchBrowser).toHaveBeenCalledWith(false);
      expect(addSpaceMember).toHaveBeenCalledWith(
        expect.objectContaining({
          page: mockPage,
          fullMemberName: 'Jane Doe',
          memberId: '12345',
          fullSpaceName: 'Marketplace',
          log: expect.any(Function),
          abortSignal: { aborted: false },
          sleep: expect.any(Function),
        }),
      );
      expect(close).toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('returns 409 when an add-space-member task is already running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    addSpaceMember.mockImplementationOnce(async () => {
      await gate;
      return { success: true };
    });

    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const firstPromise = postJson(
        server,
        { fullMemberName: 'Jane Doe', memberId: '12345', fullSpaceName: 'Marketplace' },
        '/run/add-space-member',
      );

      await expect.poll(() => addSpaceMember.mock.calls.length).toBeGreaterThan(0);

      const second = await postJson(
        server,
        { fullMemberName: 'Jane Doe', memberId: '12345', fullSpaceName: 'Marketplace' },
        '/run/add-space-member',
      );
      expect(second.status).toBe(409);
      expect(second.json).toEqual({ error: 'A task is already running' });

      release();
      const firstRes = await firstPromise;
      expect(firstRes.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  // -------------------------------------------------------------------------
  // POST /run/add-space-member-all-spaces
  // -------------------------------------------------------------------------

  it('returns 400 when fullMemberName is missing on add-space-member-all-spaces', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/add-space-member-all-spaces')
        .send({ memberId: '12345' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/fullMemberName/i);
    } finally {
      await closeServer(server);
    }
  });

  it('invokes addSpaceMember once per SPACE_IDS on add-space-member-all-spaces', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    addSpaceMember.mockResolvedValue({ success: true });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/add-space-member-all-spaces').send({
        fullMemberName: 'Jane Doe',
        memberId: '12345',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.spaces)).toBe(true);
      expect(res.body.spaces.length).toBeGreaterThan(0);
      expect(res.body.addedCount).toBe(res.body.spaces.length);
      expect(addSpaceMember).toHaveBeenCalledTimes(res.body.spaces.length);
    } finally {
      await closeServer(server);
    }
  });

  it('treats "Already a member" as a skip, not a failure', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    addSpaceMember
      .mockResolvedValueOnce({ success: true, error: 'Already a member' })
      .mockResolvedValue({ success: true });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/add-space-member-all-spaces').send({
        fullMemberName: 'Jane Doe',
        memberId: '12345',
      });
      expect(res.status).toBe(200);
      expect(res.body.alreadyMemberCount).toBe(1);
      expect(res.body.addedCount).toBe(res.body.spaces.length - 1);
      expect(res.body.failureCount).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects non-boolean `force` on add-space-member-all-spaces with 400', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server)
        .post('/run/add-space-member-all-spaces')
        .send({ fullMemberName: 'Jane Doe', memberId: '12345', force: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/force/i);
      expect(launchBrowser).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('with force=true, the all-spaces job ignores ledger present rows and visits every space', async () => {
    /* Stage 4g: seed an attempts ledger so EVERY space is already
     * marked 'present' for this member. Without `force`, the job's
     * pre-loop skip would visit zero spaces. With `force: true`, it
     * must visit every space anyway — the operator override path. */
    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    store.recordAgreement({
      memberId: '12345',
      fullName: 'Jane Doe',
      articleId: 'a1',
      commentId: 'c1',
      commentedAt: 1,
      source: 'email',
    });
    /* Mark every configured space 'present' for this member. */
    const { SPACE_IDS } = await import('../src/tasks/removeSpaceMembers.js');
    for (const spaceName of Object.keys(SPACE_IDS)) {
      store.recordSpacePresent('12345', spaceName);
    }

    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    addSpaceMember.mockResolvedValue({ success: true, error: 'Already a member' });

    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
    });
    await listen(server);
    try {
      const res = await request(server).post('/run/add-space-member-all-spaces').send({
        fullMemberName: 'Jane Doe',
        memberId: '12345',
        force: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.skippedCount).toBe(0);
      expect(addSpaceMember).toHaveBeenCalledTimes(Object.keys(SPACE_IDS).length);
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  // -------------------------------------------------------------------------
  // POST /run/reconcile-commons-membership (Stage 4c)
  // -------------------------------------------------------------------------

  it('returns 404 when agreements store is not configured', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/reconcile-commons-membership').send({});
      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('returns enqueued list for members who meet agreement threshold', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    addSpaceMember.mockResolvedValue({ success: true });

    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    store.recordAgreement({
      memberId: '70001',
      fullName: 'Reconcile Tester',
      articleId: 'article-x',
      commentId: 'c1',
      commentedAt: Date.now(),
      source: 'email',
    });

    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
    });
    await listen(server);
    try {
      const res = await request(server).post('/run/reconcile-commons-membership').send({});
      expect(res.status).toBe(200);
      expect(res.body.enqueued).toBe(1);
      expect(res.body.members).toEqual([
        { memberId: '70001', fullName: 'Reconcile Tester', agreementCount: 1 },
      ]);
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  // -------------------------------------------------------------------------
  // GET /status/agreements + POST /run/poll-agreements-mailbox (Stage 4d)
  // -------------------------------------------------------------------------

  it('returns 404 for agreements status endpoints when agreements store absent', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const stat = await request(server).get('/status/agreements');
      expect(stat.status).toBe(404);
      const poll = await request(server).post('/run/poll-agreements-mailbox').send({});
      expect(poll.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('GET /status/agreements returns DB overview & article config', async () => {
    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 3 });
    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
    });
    await listen(server);
    try {
      store.recordAgreement({
        memberId: '9',
        fullName: 'Stats Person',
        articleId: 'a1',
        commentId: 'c1',
        commentedAt: 1,
        source: 'email',
      });

      const res = await request(server).get('/status/agreements');
      expect(res.status).toBe(200);
      expect(res.body.db.requiredAgreementCount).toBe(3);
      expect(res.body.db.distinctMembersWithAgreement).toBe(1);
      expect(res.body.db.totalAgreementRows).toBe(1);
      expect(res.body.db.inProgressMemberCount).toBe(1);
      expect(res.body.imap).toBeNull();
      expect(Array.isArray(res.body.configuredAgreementArticles)).toBe(true);
      expect(res.body.configuredAgreementArticles.length).toBeGreaterThanOrEqual(1);
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  it('POST /run/poll-agreements-mailbox 404 when hook not wired', async () => {
    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
    });
    await listen(server);
    try {
      const res = await request(server).post('/run/poll-agreements-mailbox').send({});
      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  it('POST /run/poll-agreements-mailbox invokes optional poll hook', async () => {
    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    const agreementsImapPollOnce = vi.fn().mockResolvedValue({ ...EMPTY_POLL_RESULT, fetched: 2 });

    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
      agreementsImapPollOnce,
    });

    await listen(server);
    try {
      const res = await request(server).post('/run/poll-agreements-mailbox').send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ...EMPTY_POLL_RESULT, fetched: 2 });
      expect(agreementsImapPollOnce).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  // -------------------------------------------------------------------------
  // POST /run/audit-agreements (Stage 4e)
  // -------------------------------------------------------------------------

  it('POST /run/audit-agreements returns 404 when agreements store is not configured', async () => {
    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/audit-agreements').send({});
      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('POST /run/audit-agreements returns the audit result and writes audit_state to the store', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });

    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    store.recordAgreement({
      memberId: 'm-changed-mind',
      fullName: 'Changed Mindy',
      articleId: 'art-1',
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });
    store.recordAgreement({
      memberId: 'm-still-here',
      fullName: 'Steady Steven',
      articleId: 'art-1',
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
      auditAgreementsArticles: [
        {
          articleId: 'art-1',
          spaceId: 'space-1',
          title: 'The Agreement',
          url: 'https://emergent-commons.mn.co/posts/art-1',
        },
      ],
      // Mindy is gone from the page; Steven still says "I agree".
      auditAgreementsLoadAndScrape: async () => [
        {
          commentId: 'c-still-here',
          memberId: 'm-still-here',
          fullName: 'Steady Steven',
          text: 'I agree',
        },
      ],
    });

    await listen(server);
    try {
      const res = await request(server).post('/run/audit-agreements').send({});
      expect(res.status).toBe(200);
      expect(res.body.totalAnomalies).toBe(1);
      expect(res.body.totalMembersAudited).toBe(2);
      expect(res.body.anomalies[0]).toMatchObject({
        memberId: 'm-changed-mind',
        articleId: 'art-1',
        state: 'deleted',
      });
      expect(store.getAuditState('m-changed-mind', 'art-1')).toBe('deleted');
      expect(store.getAuditState('m-still-here', 'art-1')).toBe('happy');
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  it('POST /run/audit-agreements defaults to headless=true when no body field is provided', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });

    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
      auditAgreementsArticles: [],
      auditAgreementsLoadAndScrape: async () => [],
    });

    await listen(server);
    try {
      const res = await request(server).post('/run/audit-agreements').send({});
      expect(res.status).toBe(200);
      expect(launchBrowser).toHaveBeenCalledWith(true);
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  it('POST /run/audit-agreements honours { headless: false } from the body (dev-mode visible browser)', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });

    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
      auditAgreementsArticles: [],
      auditAgreementsLoadAndScrape: async () => [],
    });

    await listen(server);
    try {
      const res = await request(server)
        .post('/run/audit-agreements')
        .send({ headless: false });
      expect(res.status).toBe(200);
      expect(launchBrowser).toHaveBeenCalledWith(false);
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  it('POST /run/audit-agreements rejects non-boolean headless with 400', async () => {
    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
    });

    await listen(server);
    try {
      const res = await request(server)
        .post('/run/audit-agreements')
        .send({ headless: 'yes' });
      expect(res.status).toBe(400);
      expect(launchBrowser).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  it('POST /run/audit-agreements emails admin via sendRunLogEmail with the change-of-heart summary', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });

    const store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    store.recordAgreement({
      memberId: 'm1',
      fullName: 'Member One',
      articleId: 'art-1',
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
      sendRunLogEmail,
      auditAgreementsArticles: [
        {
          articleId: 'art-1',
          spaceId: 'space-1',
          title: 'The Agreement',
          url: 'https://emergent-commons.mn.co/posts/art-1',
        },
      ],
      auditAgreementsLoadAndScrape: async () => [],
    });

    await listen(server);
    try {
      const res = await request(server).post('/run/audit-agreements').send({});
      expect(res.status).toBe(200);
      expect(sendRunLogEmail).toHaveBeenCalledTimes(1);
      const payload = sendRunLogEmail.mock.calls[0]![0]!;
      expect(payload.taskName).toMatch(/auditAgreements/i);
      expect(payload.outcome).toBe('success');
      expect(payload.summary).toMatch(/anomaly|anomalies/);
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  // -------------------------------------------------------------------------
  // resolveAuditCronExpr (Stage 4e default-ON policy)
  // -------------------------------------------------------------------------

  describe('resolveAuditCronExpr', () => {
    it('returns the default daily 3am expression when the env var is unset', () => {
      expect(resolveAuditCronExpr(undefined)).toBe('0 3 * * *');
    });

    it('returns the default expression when the env var is empty / whitespace', () => {
      expect(resolveAuditCronExpr('')).toBe('0 3 * * *');
      expect(resolveAuditCronExpr('   ')).toBe('0 3 * * *');
    });

    it('returns null only for explicit opt-out values (case-insensitive)', () => {
      for (const v of ['off', 'OFF', 'Off', 'disabled', 'false', 'no', '0']) {
        expect(resolveAuditCronExpr(v)).toBeNull();
      }
    });

    it('treats any other non-empty value as a literal cron expression', () => {
      expect(resolveAuditCronExpr('15 4 * * *')).toBe('15 4 * * *');
      expect(resolveAuditCronExpr('  */30 * * * *  ')).toBe('*/30 * * * *');
    });
  });

  // -------------------------------------------------------------------------
  // resolveReconcileCronExpr (default-OFF; same off-sentinels as the audit)
  // -------------------------------------------------------------------------

  describe('resolveReconcileCronExpr', () => {
    /* This resolver started life as a one-line truthy check, which broke the
     * server on startup when an operator set RECONCILE_COMMONS_CRON=off
     * (the literal string "off" was handed to node-cron). It now uses the
     * same off-sentinel set as the audit cron so a single mental model
     * applies to every cron env var in this codebase. */
    it('returns null when unset / empty / whitespace (opt-in: default OFF)', () => {
      expect(resolveReconcileCronExpr(undefined)).toBeNull();
      expect(resolveReconcileCronExpr('')).toBeNull();
      expect(resolveReconcileCronExpr('   ')).toBeNull();
    });

    it('returns null for the off-sentinel set (case-insensitive)', () => {
      for (const v of ['off', 'OFF', 'Off', 'disabled', 'false', 'no', '0']) {
        expect(resolveReconcileCronExpr(v)).toBeNull();
      }
    });

    it('treats any other non-empty value as a literal cron expression', () => {
      expect(resolveReconcileCronExpr('30 2 * * *')).toBe('30 2 * * *');
      expect(resolveReconcileCronExpr('  */15 * * * *  ')).toBe('*/15 * * * *');
    });
  });

  // -------------------------------------------------------------------------
  // Admin-email-on-run hook
  // -------------------------------------------------------------------------

  it('calls sendRunLogEmail with captured log lines + success summary on success', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    removeSpaceMembers.mockImplementation(async ({ log }: { log: (m: string) => void }) => {
      log('doing things');
      log('done things');
      return { success: true, removed: 2 };
    });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember, sendRunLogEmail });
    await listen(server);
    try {
      const res = await request(server).post('/run/remove-space-members').send({
        fullSpaceName: 'Marketplace',
        dryRun: false,
        headless: true,
      });
      expect(res.status).toBe(200);

      /* The email is fire-and-forget in a finally block, so we may need to
       * yield a tick for the scheduled send to land. Poll briefly. */
      await expect.poll(() => sendRunLogEmail.mock.calls.length).toBeGreaterThan(0);

      const payload = sendRunLogEmail.mock.calls[0][0];
      expect(payload.outcome).toBe('success');
      expect(payload.taskName).toContain('Marketplace');
      expect(payload.summary).toContain('2 removed');
      expect(payload.logLines).toEqual(expect.arrayContaining(['doing things', 'done things']));
      expect(payload.result).toEqual({ success: true, removed: 2 });
    } finally {
      await closeServer(server);
    }
  });

  it('calls sendRunLogEmail with outcome=error when the task throws', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    removeSpaceMembers.mockRejectedValue(new Error('boom'));

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember, sendRunLogEmail });
    await listen(server);
    try {
      const res = await request(server).post('/run/remove-space-members').send({
        fullSpaceName: 'Marketplace',
      });
      expect(res.status).toBe(500);

      await expect.poll(() => sendRunLogEmail.mock.calls.length).toBeGreaterThan(0);

      const payload = sendRunLogEmail.mock.calls[0][0];
      expect(payload.outcome).toBe('error');
      expect(payload.summary).toContain('boom');
      expect(payload.result).toEqual({ error: 'boom' });
    } finally {
      await closeServer(server);
    }
  });

  it('does not let sendRunLogEmail failures affect the HTTP response', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    removeSpaceMembers.mockResolvedValue({ success: true, removed: 0 });
    const throwingEmail = vi.fn().mockRejectedValue(new Error('smtp down'));

    const server = createApp({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      sendRunLogEmail: throwingEmail,
    });
    await listen(server);
    try {
      const res = await request(server).post('/run/remove-space-members').send({
        fullSpaceName: 'Marketplace',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, removed: 0 });
      await expect.poll(() => throwingEmail.mock.calls.length).toBeGreaterThan(0);
    } finally {
      await closeServer(server);
    }
  });

  it('continues the all-spaces loop after a non-"Already" failure and reports it', async () => {
    const mockPage = buildMockPage();
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    addSpaceMember
      .mockResolvedValueOnce({ success: false, error: 'Toast did not appear' })
      .mockResolvedValue({ success: true });

    const server = createApp({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/add-space-member-all-spaces').send({
        fullMemberName: 'Jane Doe',
        memberId: '12345',
      });
      expect(res.status).toBe(200);
      expect(res.body.failureCount).toBe(1);
      expect(addSpaceMember).toHaveBeenCalledTimes(res.body.spaces.length);
      const failed = res.body.spaces.find((s: { success: boolean }) => !s.success);
      expect(failed.error).toMatch(/toast/i);
    } finally {
      await closeServer(server);
    }
  });
});

/**
 * The ineligibility list is loaded statically at module load
 * (`src/config/ineligibleMembers.ts`), so the only clean test seam
 * is `vi.doMock` + dynamic re-import of `createApp`. This isolated
 * describe block uses `vi.resetModules()` per test so the rest of
 * the suite keeps the empty default list.
 */
describe('ineligibility gate (server)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../src/config/ineligibleMembers.js');
  });

  async function loadAppWithIneligibles(
    ineligibles: Array<{ memberId: string; fullName: string; reason: string }>,
  ): Promise<typeof import('../src/server.js')> {
    vi.doMock('../src/config/ineligibleMembers.js', () => {
      const byId = new Map(ineligibles.map((m) => [m.memberId, m]));
      return {
        INELIGIBLE_MEMBERS: ineligibles,
        isMemberIneligible: (id: string) => byId.has(id),
        getIneligibilityReason: (id: string) => byId.get(id)?.reason ?? null,
      };
    });
    return await import('../src/server.js');
  }

  it('returns 403 on /run/add-space-member-all-spaces for an ineligible member', async () => {
    const { createApp: createAppMocked } = await loadAppWithIneligibles([
      { memberId: '12345', fullName: 'Jane Doe', reason: 'banned 2026' },
    ]);
    const launchBrowser = vi.fn();
    const addSpaceMember = vi.fn();
    const removeSpaceMembers = vi.fn();
    const server = createAppMocked({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/add-space-member-all-spaces').send({
        fullMemberName: 'Jane Doe',
        memberId: '12345',
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        memberId: '12345',
        reason: 'banned 2026',
      });
      expect(launchBrowser).not.toHaveBeenCalled();
      expect(addSpaceMember).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('force=true does NOT bypass ineligibility', async () => {
    const { createApp: createAppMocked } = await loadAppWithIneligibles([
      { memberId: '12345', fullName: 'Jane Doe', reason: 'banned 2026' },
    ]);
    const launchBrowser = vi.fn();
    const addSpaceMember = vi.fn();
    const removeSpaceMembers = vi.fn();
    const server = createAppMocked({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/add-space-member-all-spaces').send({
        fullMemberName: 'Jane Doe',
        memberId: '12345',
        force: true,
      });
      expect(res.status).toBe(403);
      expect(launchBrowser).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('returns 403 on /run/add-space-member (single space) for an ineligible member', async () => {
    const { createApp: createAppMocked } = await loadAppWithIneligibles([
      { memberId: '99999', fullName: 'Blocked Person', reason: 'duplicate account' },
    ]);
    const launchBrowser = vi.fn();
    const addSpaceMember = vi.fn();
    const removeSpaceMembers = vi.fn();
    const server = createAppMocked({ launchBrowser, removeSpaceMembers, addSpaceMember });
    await listen(server);
    try {
      const res = await request(server).post('/run/add-space-member').send({
        fullMemberName: 'Blocked Person',
        memberId: '99999',
        fullSpaceName: '8. Miscellaneous',
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        memberId: '99999',
        reason: 'duplicate account',
      });
      expect(launchBrowser).not.toHaveBeenCalled();
      expect(addSpaceMember).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('GET /status/agreements filters ineligibles from actionable list and exposes ineligibleMembers', async () => {
    const { createApp: createAppMocked } = await loadAppWithIneligibles([
      { memberId: 'banned-1', fullName: 'Banned Bob', reason: 'codeofconduct' },
    ]);
    const { openAgreementsStore: openStore } = await import('../src/state/agreementsStore.js');

    const store = openStore({ filePath: ':memory:', requiredAgreementCount: 1 });
    /* Both members reach threshold; only the ineligible one should
     * be filtered out of the actionable list, but their raw count
     * is preserved in the diagnostic field. */
    store.recordAgreement({
      memberId: 'banned-1',
      fullName: 'Banned Bob',
      articleId: 'a1',
      commentId: 'c1',
      commentedAt: 1,
      source: 'email',
    });
    store.recordAgreement({
      memberId: 'ok-1',
      fullName: 'Ok Olive',
      articleId: 'a1',
      commentId: 'c2',
      commentedAt: 1,
      source: 'email',
    });

    const launchBrowser = vi.fn();
    const addSpaceMember = vi.fn();
    const removeSpaceMembers = vi.fn();
    const server = createAppMocked({
      launchBrowser,
      removeSpaceMembers,
      addSpaceMember,
      agreementsStore: store,
    });
    await listen(server);
    try {
      const res = await request(server).get('/status/agreements');
      expect(res.status).toBe(200);

      const ids = res.body.db.eligibleNotYetAddedMembers.map(
        (m: { memberId: string }) => m.memberId,
      );
      expect(ids).toContain('ok-1');
      expect(ids).not.toContain('banned-1');

      expect(res.body.db.eligibleNotYetAddedCount).toBe(1);
      expect(res.body.db.eligibleNotYetAddedTotalIncludingIneligible).toBe(2);

      expect(res.body.ineligibleMembers).toEqual([
        { memberId: 'banned-1', fullName: 'Banned Bob', reason: 'codeofconduct' },
      ]);
    } finally {
      await closeServer(server);
      store.close();
    }
  });
});
