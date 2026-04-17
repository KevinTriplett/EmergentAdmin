import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'puppeteer';
import { createApp } from '../src/server.js';

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

  beforeEach(() => {
    close.mockClear();
    newPage.mockReset();
    launchBrowser.mockReset();
    removeSpaceMembers.mockReset();
    addSpaceMember.mockReset();
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
