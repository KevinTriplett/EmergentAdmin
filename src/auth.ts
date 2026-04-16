import type { Page } from 'puppeteer';

// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_SIGN_IN = 'body.auth-sign_in';
const SEL_GDPR_CONSENT = '#c-p-bn';
const SEL_SIGNED_IN = 'body.communities-app';

// === TEXT LABELS — UPDATE THESE IF MN CHANGES ITS UI TEXT ===
const TXT_EMAIL = 'Email';
const TXT_NEXT = 'Next';
const TXT_SIGN_IN_WITH_PASSWORD = 'Sign In with Password';
const TXT_PASSWORD = 'Password';

const LOGIN_URL = 'https://emergent-commons.mn.co/sign_in';

export type LogFn = (message: string) => void | Promise<void>;

export type LoginDeps = {
  login?: (page: Page, log: LogFn) => Promise<{ success: true }>;
};

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
  await page.evaluate(
    (emailLabel, value) => {
      function findEmailInput(): HTMLInputElement | null {
        for (const el of document.querySelectorAll('input')) {
          const ph = el.getAttribute('placeholder') ?? '';
          const aria = el.getAttribute('aria-label') ?? '';
          if (ph.includes(emailLabel) || aria.includes(emailLabel)) {
            return el as HTMLInputElement;
          }
        }
        for (const label of document.querySelectorAll('label')) {
          if (label.textContent?.includes(emailLabel)) {
            const forId = label.getAttribute('for');
            if (forId) {
              const input = document.getElementById(forId);
              if (input instanceof HTMLInputElement) return input;
            }
          }
        }
        return null;
      }
      const input = findEmailInput();
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
      function findPasswordInput(): HTMLInputElement | null {
        for (const el of document.querySelectorAll('input')) {
          if (el.getAttribute('type') !== 'password') continue;
          const ph = el.getAttribute('placeholder') ?? '';
          const aria = el.getAttribute('aria-label') ?? '';
          if (ph.includes(pwdLabel) || aria.includes(pwdLabel)) {
            return el as HTMLInputElement;
          }
        }
        for (const label of document.querySelectorAll('label')) {
          if (label.textContent?.includes(pwdLabel)) {
            const forId = label.getAttribute('for');
            if (forId) {
              const input = document.getElementById(forId);
              if (input instanceof HTMLInputElement) return input;
            }
          }
        }
        return document.querySelector('input[type="password"]') as HTMLInputElement | null;
      }
      const input = findPasswordInput();
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
    await page.waitForSelector(SEL_READY, { timeout: 60_000 });
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
      (t) => {
        const nodes = Array.from(document.querySelectorAll('a, button, span'));
        return nodes.some((n) => n.textContent?.trim() === t);
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
