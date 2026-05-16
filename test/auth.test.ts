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

  it('completes privacy agreement form before checking signed-in state', async () => {
    /* The server may redirect a previously authenticated session to
     * /onboarding/privacy_agreement before exposing the signed-in shell.
     * loginIfNeeded must complete the form (agree, activity-emails, submit)
     * and then re-detect the signed-in shell — without invoking login(). */
    const state = {
      privacyAgreementPresent: true,
      agreeUncheckedPresent: true,
      emailsUncheckedPresent: true,
    };
    const agreeHandle = {
      click: vi.fn(async () => {
        state.agreeUncheckedPresent = false;
      }),
      dispose: vi.fn(),
    };
    const emailsHandle = {
      click: vi.fn(async () => {
        state.emailsUncheckedPresent = false;
      }),
      dispose: vi.fn(),
    };
    const submitHandle = {
      click: vi.fn(async () => {
        state.privacyAgreementPresent = false;
      }),
      dispose: vi.fn(),
    };
    const page = {
      title: vi.fn().mockResolvedValue('Privacy Agreement | Mighty Networks'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(null),
      $: vi.fn((sel: string) => {
        if (sel === 'body.onboarding-privacy_agreement') {
          return Promise.resolve(state.privacyAgreementPresent ? {} : null);
        }
        if (sel.includes('privacy-form-activity-emails-agree')) {
          return Promise.resolve(state.emailsUncheckedPresent ? emailsHandle : null);
        }
        if (sel.includes('privacy-form-agree')) {
          return Promise.resolve(state.agreeUncheckedPresent ? agreeHandle : null);
        }
        if (sel.includes('privacy-agreement-form')) {
          return Promise.resolve(state.privacyAgreementPresent ? submitHandle : null);
        }
        if (sel.includes('communities-app')) {
          return Promise.resolve(state.privacyAgreementPresent ? null : {});
        }
        return Promise.resolve(null);
      }),
    } as unknown as Page;

    const login = vi.fn().mockResolvedValue({ success: true });
    await loginIfNeeded(page, log, { login });

    expect(agreeHandle.click).toHaveBeenCalledOnce();
    expect(emailsHandle.click).toHaveBeenCalledOnce();
    expect(submitHandle.click).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Already logged in — skipping login.');
  });

  it('skips privacy form checkboxes that are already checked', async () => {
    /* If a checkbox is pre-checked the unchecked-icon selector returns null
     * and we must not throw — only the submit click is required. */
    const state = { privacyAgreementPresent: true };
    const submitHandle = {
      click: vi.fn(async () => {
        state.privacyAgreementPresent = false;
      }),
      dispose: vi.fn(),
    };
    const page = {
      title: vi.fn().mockResolvedValue('Privacy Agreement | Mighty Networks'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(null),
      $: vi.fn((sel: string) => {
        if (sel === 'body.onboarding-privacy_agreement') {
          return Promise.resolve(state.privacyAgreementPresent ? {} : null);
        }
        if (sel.includes('privacy-form-agree') || sel.includes('privacy-form-activity-emails-agree')) {
          return Promise.resolve(null);
        }
        if (sel.includes('privacy-agreement-form')) {
          return Promise.resolve(state.privacyAgreementPresent ? submitHandle : null);
        }
        if (sel.includes('communities-app')) {
          return Promise.resolve(state.privacyAgreementPresent ? null : {});
        }
        return Promise.resolve(null);
      }),
    } as unknown as Page;

    const login = vi.fn().mockResolvedValue({ success: true });
    await loginIfNeeded(page, log, { login });

    expect(submitHandle.click).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Already logged in — skipping login.');
  });

  it('throws when privacy agreement modal is present but submit button is missing', async () => {
    const page = {
      title: vi.fn().mockResolvedValue('Privacy Agreement | Mighty Networks'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(null),
      $: vi.fn((sel: string) => {
        if (sel === 'body.onboarding-privacy_agreement') return Promise.resolve({});
        return Promise.resolve(null);
      }),
    } as unknown as Page;

    await expect(loginIfNeeded(page, log)).rejects.toThrow(/privacy agreement submit/i);
  });
});
