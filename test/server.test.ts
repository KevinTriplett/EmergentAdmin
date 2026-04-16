import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'puppeteer';
import { createApp } from '../src/server.js';

function postJson(server: Server, body: object): Promise<{ status: number; json: unknown }> {
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
        path: '/run/remove-space-members',
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

  beforeEach(() => {
    close.mockClear();
    newPage.mockReset();
    launchBrowser.mockReset();
    removeSpaceMembers.mockReset();
  });

  it('returns 400 when fullSpaceName is missing', async () => {
    launchBrowser.mockRejectedValue(new Error('should not launch'));
    const server = createApp({ launchBrowser, removeSpaceMembers });
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
    const server = createApp({ launchBrowser, removeSpaceMembers });
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

    const mockPage = {} as unknown as Page;
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });

    const server = createApp({ launchBrowser, removeSpaceMembers });
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
    const server = createApp({ launchBrowser, removeSpaceMembers });
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
    const mockPage = {} as unknown as Page;
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    removeSpaceMembers.mockResolvedValue({ success: true, removed: 0 });

    const server = createApp({ launchBrowser, removeSpaceMembers });
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
    const mockPage = {} as unknown as Page;
    newPage.mockResolvedValue(mockPage);
    launchBrowser.mockResolvedValue({ newPage, close });
    removeSpaceMembers.mockResolvedValue({ success: true, removed: 0 });

    const server = createApp({ launchBrowser, removeSpaceMembers });
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
    const server = createApp({ launchBrowser, removeSpaceMembers });
    await listen(server);
    try {
      const res = await request(server).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('MN Host Automator');
    } finally {
      await closeServer(server);
    }
  });
});
