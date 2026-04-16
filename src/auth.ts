import type { Page } from 'puppeteer';

// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_SIGN_IN = 'body.auth-sign_in';
const SEL_LANDING = 'body.communities-landing';
const SEL_GDPR_CONSENT = '#c-p-bn';
const SEL_SIGNED_IN = 'body.communities-app';

// === TEXT LABELS — UPDATE THESE IF MN CHANGES ITS UI TEXT ===
const TXT_LANDING_SIGN_IN = 'Sign In';
const TXT_EMAIL = 'Email';
const TXT_NEXT = 'Next';
const TXT_SIGN_IN_WITH_PASSWORD = 'Sign In with Password';
const TXT_PASSWORD = 'Password';

const LOGIN_URL = 'https://emergent-commons.mn.co/sign_in';

export type LogFn = (message: string) => void | Promise<void>;

export type LoginDeps = {
  login?: (page: Page, log: LogFn) => Promise<{ success: true }>;
};

const AUTH_SHELL_WAIT_MS = 10_000;
const CHALLENGE_CLEAR_WAIT_MS = 90_000;

/** Clicks that trigger a document navigation often kill the context before `evaluate` returns. */
function isExecutionContextDestroyedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Execution context was destroyed') ||
    msg.includes('Cannot find context with specified id') ||
    msg.includes('Target closed')
  );
}

function isDetachedFrameError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('detached Frame') || msg.includes('Attempted to use detached Frame');
}

async function clickFirstWithExactText(page: Page, text: string): Promise<void> {
  const clicked = await page.evaluate((label) => {
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'));
    for (const node of nodes) {
      if (node.textContent?.trim() === label) {
        (node as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, text);
  if (!clicked) {
    throw new Error(`Could not find clickable element with exact text: ${text}`);
  }
}

async function fillEmail(page: Page, email: string): Promise<void> {
  /* No nested `function` declarations here — TS/esbuild can inject `__name()` into
   * serialized `page.evaluate` bodies, which throws in the browser ("__name is not defined"). */
  await page.evaluate(
    (emailLabel, value) => {
      let input: HTMLInputElement | null = null;
      for (const el of document.querySelectorAll('input')) {
        const inp = el as HTMLInputElement;
        const ph = inp.getAttribute('placeholder') || '';
        const aria = inp.getAttribute('aria-label') || '';
        if (ph.includes(emailLabel) || aria.includes(emailLabel)) {
          input = inp;
          break;
        }
      }
      if (!input) {
        for (const label of document.querySelectorAll('label')) {
          const text = label.textContent || '';
          if (text.includes(emailLabel)) {
            const forId = label.getAttribute('for');
            if (forId) {
              const el = document.getElementById(forId);
              if (el && el.tagName === 'INPUT') {
                input = el as HTMLInputElement;
                break;
              }
            }
          }
        }
      }
      if (!input) throw new Error('email input not found');
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    TXT_EMAIL,
    email,
  );
}

async function fillPassword(page: Page, password: string): Promise<void> {
  await page.evaluate(
    (pwdLabel, value) => {
      let input: HTMLInputElement | null = null;
      for (const el of document.querySelectorAll('input')) {
        const inp = el as HTMLInputElement;
        if (inp.getAttribute('type') !== 'password') continue;
        const ph = inp.getAttribute('placeholder') || '';
        const aria = inp.getAttribute('aria-label') || '';
        if (ph.includes(pwdLabel) || aria.includes(pwdLabel)) {
          input = inp;
          break;
        }
      }
      if (!input) {
        for (const label of document.querySelectorAll('label')) {
          const text = label.textContent || '';
          if (text.includes(pwdLabel)) {
            const forId = label.getAttribute('for');
            if (forId) {
              const el = document.getElementById(forId);
              if (el && el.tagName === 'INPUT') {
                input = el as HTMLInputElement;
                break;
              }
            }
          }
        }
      }
      if (!input) {
        input = document.querySelector('input[type="password"]') as HTMLInputElement | null;
      }
      if (!input) throw new Error('password input not found');
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    TXT_PASSWORD,
    password,
  );
}

async function handleGdprConsentIfPresent(page: Page, log: LogFn): Promise<void> {
  await log('Handling GDPR consent...');
  const gdpr = await page.$(SEL_GDPR_CONSENT);
  if (gdpr) {
    try {
      await gdpr.click();
    } finally {
      if (typeof gdpr.dispose === 'function') {
        await gdpr.dispose();
      }
    }
  } else {
    await log('No GDPR consent dialog — skipping');
  }
}

async function waitForChallengeClearIfPresent(page: Page, log: LogFn): Promise<void> {
  const title = await page.title().catch(() => '');
  if (!title.includes('Just a moment')) {
    return;
  }

  await log('Detected challenge page; waiting for clearance...');
  await page.waitForFunction(
    ({ signIn, signedIn, landing }) => {
      if (!document.title.includes('Just a moment')) {
        return true;
      }
      return (
        Boolean(document.querySelector(signIn)) ||
        Boolean(document.querySelector(signedIn)) ||
        Boolean(document.querySelector(landing))
      );
    },
    { timeout: CHALLENGE_CLEAR_WAIT_MS },
    { signIn: SEL_SIGN_IN, signedIn: SEL_SIGNED_IN, landing: SEL_LANDING },
  );
  await log('Challenge cleared. Continuing auth checks...');
}

export async function login(page: Page, log: LogFn): Promise<{ success: true }> {
  const email = process.env.MN_EMAIL;
  const password = process.env.MN_PASSWORD;
  if (!email || !password) {
    throw new Error('MN_EMAIL and MN_PASSWORD must be set in the environment');
  }

  try {
    await log('Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    await log('Waiting for app shell...');
    await page.waitForSelector(SEL_SIGN_IN, { timeout: 60_000 });

    await log('Entering email...');
    await fillEmail(page, email);

    await log('Clicking Next...');
    await clickFirstWithExactText(page, TXT_NEXT);

    await log('Selecting password sign-in...');
    await page.waitForFunction(
      (label) => {
        const nodes = document.querySelectorAll('a, button, span');
        for (let i = 0; i < nodes.length; i++) {
          const tc = nodes[i].textContent;
          if (tc && tc.trim() === label) {
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
      TXT_SIGN_IN_WITH_PASSWORD,
    );
    await clickFirstWithExactText(page, TXT_SIGN_IN_WITH_PASSWORD);

    await log('Entering password...');
    await fillPassword(page, password);

    await log('Submitting login...');
    await clickFirstWithExactText(page, TXT_NEXT);

    await page.waitForSelector(SEL_SIGNED_IN, { timeout: 15_000 });
    await log('Login confirmed.');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(message);
    throw new Error(
      'Login failed — check credentials or MN_COMMUNITY_URL in .env',
      { cause: err },
    );
  }
}

export async function loginIfNeeded(
  page: Page,
  log: LogFn,
  deps: LoginDeps = {},
): Promise<void> {
  await log('Waiting for app shell...');
  await waitForChallengeClearIfPresent(page, log);
  const shellSelectors = { signIn: SEL_SIGN_IN, signedIn: SEL_SIGNED_IN, landing: SEL_LANDING };
  let shellReady = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.waitForFunction(
        ({ signIn, signedIn, landing }) =>
          Boolean(document.querySelector(signIn)) ||
          Boolean(document.querySelector(signedIn)) ||
          Boolean(document.querySelector(landing)),
        { timeout: AUTH_SHELL_WAIT_MS },
        shellSelectors,
      );
      shellReady = true;
      break;
    } catch (err) {
      if (isDetachedFrameError(err) || isExecutionContextDestroyedError(err)) {
        await log(`Auth shell wait interrupted by navigation/frame swap (attempt ${attempt}/3).`);
        if (attempt < 3) {
          await page
            .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: AUTH_SHELL_WAIT_MS })
            .catch(() => undefined);
          continue;
        }
      }

      try {
        const shellState = await page.evaluate(
          ({ ready, signIn, signedIn, landing, gdpr }) => ({
            url: location.href,
            title: document.title,
            bodyClass: document.body?.className ?? '',
            readyFound: Boolean(document.querySelector(ready)),
            signInFound: Boolean(document.querySelector(signIn)),
            signedInFound: Boolean(document.querySelector(signedIn)),
            landingFound: Boolean(document.querySelector(landing)),
            gdprFound: Boolean(document.querySelector(gdpr)),
          }),
          {
            ready: SEL_READY,
            signIn: SEL_SIGN_IN,
            signedIn: SEL_SIGNED_IN,
            landing: SEL_LANDING,
            gdpr: SEL_GDPR_CONSENT,
          },
        );
        await log(
          `Auth shell timeout debug: url=${shellState.url} title="${shellState.title}" bodyClass="${shellState.bodyClass}"`,
        );
        await log(
          `Auth shell timeout debug: ready=${shellState.readyFound} signIn=${shellState.signInFound} signedIn=${shellState.signedInFound} landing=${shellState.landingFound} gdpr=${shellState.gdprFound}`,
        );
      } catch (debugErr) {
        const debugMsg = debugErr instanceof Error ? debugErr.message : String(debugErr);
        await log(`Auth shell timeout debug unavailable: ${debugMsg}`);
        await log(`Auth shell timeout fallback URL: ${page.url()}`);
      }

      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Timed out waiting for auth shell. ${message}`, { cause: err });
    }
  }
  if (!shellReady) {
    throw new Error('Timed out waiting for auth shell after retries.');
  }

  const landing = await page.$(SEL_LANDING);
  if (landing) {
    if (typeof landing.dispose === 'function') {
      await landing.dispose();
    }
    await log('Landing page — navigating to sign-in page...');
    try {
      await clickFirstWithExactText(page, TXT_LANDING_SIGN_IN);
    } catch (err) {
      if (!isExecutionContextDestroyedError(err)) {
        throw err;
      }
    }
    await page.waitForSelector(SEL_SIGN_IN, { timeout: 60_000 });
  }

  await handleGdprConsentIfPresent(page, log);

  const signIn = await page.$(SEL_SIGN_IN);
  if (signIn) {
    if (typeof signIn.dispose === 'function') {
      await signIn.dispose();
    }
    const runLogin = deps.login ?? login;
    await runLogin(page, log);
    return;
  }

  const signedIn = await page.$(SEL_SIGNED_IN);
  if (signedIn) {
    if (typeof signedIn.dispose === 'function') {
      await signedIn.dispose();
    }
    await log('Already logged in — skipping login.');
    return;
  }

  throw new Error('Unknown authentication state: neither sign-in nor signed-in shell detected.');
}
