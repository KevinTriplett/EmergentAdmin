import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page } from 'puppeteer';
import { login, loginIfNeeded } from '../src/auth.js';

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

describe('login', () => {
  const log = vi.fn<(m: string) => Promise<void>>().mockResolvedValue(undefined);
  let savedEmail: string | undefined;
  let savedPassword: string | undefined;

  beforeEach(() => {
    log.mockClear();
    savedEmail = process.env.MN_EMAIL;
    savedPassword = process.env.MN_PASSWORD;
    process.env.MN_EMAIL = 'test@example.com';
    process.env.MN_PASSWORD = 'hunter2';
  });

  afterEach(() => {
    if (savedEmail === undefined) delete process.env.MN_EMAIL;
    else process.env.MN_EMAIL = savedEmail;
    if (savedPassword === undefined) delete process.env.MN_PASSWORD;
    else process.env.MN_PASSWORD = savedPassword;
  });

  /* The deploy-machine failure 20260516T163212Z showed body.auth-sign_in
   * matching SEL_SIGN_IN while pace.js was still running and the email
   * input had not yet rendered. SEL_SIGN_IN is a *routing* signal —
   * not a *mounted-form* signal. login() must wait for the actual
   * email/password inputs to mount before calling fillEmail/fillPassword,
   * otherwise the one-shot page.evaluate inside those helpers throws
   * "email input not found"/"password input not found" and the run
   * fails three steps before reaching the privacy agreement handler. */

  type EvaluateArgs = readonly unknown[];

  function makeLoginPage(calls: string[]): Page {
    return {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue({}),
      waitForFunction: vi.fn(async (_fn: unknown, _opts: unknown, arg: unknown) => {
        if (arg === 'Email') calls.push('waitInput:Email');
        else if (arg === 'Password') calls.push('waitInput:Password');
        else if (arg === 'Sign In with Password') calls.push('waitLabel:SignInWithPassword');
        else if (arg && typeof arg === 'object' && 'signedIn' in (arg as object)) {
          calls.push('waitShell:signedInOrPrivacy');
        } else {
          calls.push('waitFn:other');
        }
        return undefined;
      }),
      evaluate: vi.fn(async (_fn: unknown, ...args: EvaluateArgs) => {
        const tag = args[0];
        if (tag === 'Email') {
          calls.push('fillEmail');
          return undefined;
        }
        if (tag === 'Password') {
          calls.push('fillPassword');
          return undefined;
        }
        if (tag === 'Next') {
          calls.push('clickNext');
          return true;
        }
        if (tag === 'Sign In with Password') {
          calls.push('clickSignInWithPassword');
          return true;
        }
        calls.push('evaluate:other');
        return undefined;
      }),
      $: vi.fn().mockResolvedValue(null),
      title: vi.fn().mockResolvedValue(''),
    } as unknown as Page;
  }

  it('waits for the email input to mount before calling fillEmail', async () => {
    const calls: string[] = [];
    const page = makeLoginPage(calls);

    await login(page, log);

    const waitIdx = calls.indexOf('waitInput:Email');
    const fillIdx = calls.indexOf('fillEmail');
    expect(waitIdx).toBeGreaterThanOrEqual(0);
    expect(fillIdx).toBeGreaterThan(waitIdx);
  });

  it('waits for the password input to mount before calling fillPassword', async () => {
    const calls: string[] = [];
    const page = makeLoginPage(calls);

    await login(page, log);

    const waitIdx = calls.indexOf('waitInput:Password');
    const fillIdx = calls.indexOf('fillPassword');
    expect(waitIdx).toBeGreaterThanOrEqual(0);
    expect(fillIdx).toBeGreaterThan(waitIdx);
  });
});
