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

/** Clicks that trigger a document navigation often kill the context before `evaluate` returns. */
function isExecutionContextDestroyedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Execution context was destroyed') ||
    msg.includes('Cannot find context with specified id') ||
    msg.includes('Target closed')
  );
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

    await log('Handling GDPR consent...');
    const gdpr = await page.$(SEL_GDPR_CONSENT);
    if (gdpr) {
      await gdpr.click();
      await gdpr.dispose();
    } else {
      await log('No GDPR consent dialog — skipping');
    }

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
  const signIn = await page.$(SEL_SIGN_IN);
  if (signIn) {
    if (typeof signIn.dispose === 'function') {
      await signIn.dispose();
    }
    const runLogin = deps.login ?? login;
    await runLogin(page, log);
    return;
  }
  await log('Already logged in — skipping login.');
}
