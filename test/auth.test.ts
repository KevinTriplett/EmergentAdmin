import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'puppeteer';
import { loginIfNeeded } from '../src/auth.js';

describe('loginIfNeeded', () => {
  const log = vi.fn<(m: string) => Promise<void>>().mockResolvedValue(undefined);

  beforeEach(() => {
    log.mockClear();
  });

  it('logs skip when signed-in shell is present', async () => {
    const page = {
      title: vi.fn().mockResolvedValue('Members'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      $: vi.fn((sel: string) => {
        if (sel.includes('communities-app')) return Promise.resolve({});
        return Promise.resolve(null);
      }),
    } as unknown as Page;

    await loginIfNeeded(page, log);

    expect(page.$).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Already logged in — skipping login.');
  });

  it('invokes injected login when sign-in body is present', async () => {
    const fakeHandle = {};
    const page = {
      title: vi.fn().mockResolvedValue('Sign in'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      $: vi.fn((sel: string) => {
        if (sel.includes('communities-landing')) return Promise.resolve(null);
        if (sel.includes('auth-sign_in')) return Promise.resolve(fakeHandle);
        return Promise.resolve(null);
      }),
    } as unknown as Page;

    const login = vi.fn().mockResolvedValue({ success: true });

    await loginIfNeeded(page, log, { login });

    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith(page, log);
    expect(log).not.toHaveBeenCalledWith('Already logged in — skipping login.');
  });

  it('throws when no known auth shell is present after waiting', async () => {
    const page = {
      title: vi.fn().mockResolvedValue('Unknown'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      $: vi.fn().mockResolvedValue(null),
    } as unknown as Page;

    await expect(loginIfNeeded(page, log)).rejects.toThrow('Unknown authentication state');
  });

  it('waits for challenge page clearance when title is just a moment', async () => {
    const fakeHandle = {};
    const page = {
      title: vi.fn().mockResolvedValue('Just a moment...'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      $: vi.fn((sel: string) => {
        if (sel.includes('auth-sign_in')) return Promise.resolve(fakeHandle);
        return Promise.resolve(null);
      }),
    } as unknown as Page;

    const login = vi.fn().mockResolvedValue({ success: true });
    await loginIfNeeded(page, log, { login });

    expect(log).toHaveBeenCalledWith('Detected challenge page; waiting for clearance...');
    expect(log).toHaveBeenCalledWith('Challenge cleared. Continuing auth checks...');
    expect(login).toHaveBeenCalledOnce();
  });
});
