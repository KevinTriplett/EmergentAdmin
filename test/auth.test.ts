import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'puppeteer';
import { loginIfNeeded } from '../src/auth.js';

describe('loginIfNeeded', () => {
  const log = vi.fn<(m: string) => Promise<void>>().mockResolvedValue(undefined);

  beforeEach(() => {
    log.mockClear();
  });

  it('logs skip when sign-in body is not present', async () => {
    const page = {
      $: vi.fn().mockResolvedValue(null),
    } as unknown as Page;

    await loginIfNeeded(page, log);

    expect(page.$).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Already logged in — skipping login.');
  });

  it('invokes injected login when sign-in body is present', async () => {
    const fakeHandle = {};
    const page = {
      $: vi.fn().mockResolvedValue(fakeHandle),
    } as unknown as Page;

    const login = vi.fn().mockResolvedValue({ success: true });

    await loginIfNeeded(page, log, { login });

    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith(page, log);
    expect(log).not.toHaveBeenCalledWith('Already logged in — skipping login.');
  });
});
