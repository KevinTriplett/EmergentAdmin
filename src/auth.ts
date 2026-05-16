import type { Page } from 'puppeteer';
import { writeProfileAccount } from './utils/browser.js';

// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_SIGN_IN = 'body.auth-sign_in';
const SEL_LANDING = 'body.communities-landing';
const SEL_GDPR_CONSENT = '#c-p-bn';
const SEL_SIGNED_IN = 'body.communities-app';
const SEL_PRIVACY_AGREEMENT = 'body.onboarding-privacy_agreement';
const SEL_PRIVACY_FORM_AGREE = 'label.privacy-form-agree span.unchecked-icon';
const SEL_PRIVACY_FORM_EMAILS = 'label.privacy-form-activity-emails-agree span.unchecked-icon';
const SEL_PRIVACY_FORM_SUBMIT = ".privacy-agreement-form button[type='button-submit']"

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
/* `body.auth-sign_in` is set at domcontentloaded but the React auth
 * form mounts later. Without this wait, fillEmail/fillPassword race
 * the form-mount and throw "<x> input not found" mid-load. 30s gives
 * even the slow deploy host comfortable headroom. */
const AUTH_INPUT_WAIT_MS = 30_000;

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

async function rememberProfileAccount(
  email: string | undefined,
  log: LogFn,
): Promise<void> {
  const profileDir = process.env.PUPPETEER_USER_DATA_DIR?.trim();
  if (!profileDir || !email) return;
  try {
    await writeProfileAccount(profileDir, email);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`Warning: could not record profile account binding (${message}).`);
  }
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

/**
 * Postcondition wait after `waitForSelector(SEL_SIGN_IN)`: the body
 * class is set early by MN's router, so the input itself is the real
 * "ready to fill" signal. Predicate mirrors `fillEmail`'s lookup
 * (placeholder / aria-label / `<label for=…>`) so the wait succeeds
 * iff the subsequent `fillEmail` call will succeed.
 *
 * Per system_prompt §11, the predicate has no nested named
 * functions — only inline anonymous arrows / imperative loops — so
 * esbuild's `__name` shim cannot be injected.
 */
async function waitForEmailInput(page: Page): Promise<void> {
  await page.waitForFunction(
    (emailLabel) => {
      for (const el of document.querySelectorAll('input')) {
        const inp = el as HTMLInputElement;
        const ph = inp.getAttribute('placeholder') || '';
        const aria = inp.getAttribute('aria-label') || '';
        if (ph.includes(emailLabel) || aria.includes(emailLabel)) return true;
      }
      for (const labelEl of document.querySelectorAll('label')) {
        const text = labelEl.textContent || '';
        if (text.includes(emailLabel)) {
          const forId = labelEl.getAttribute('for');
          if (forId) {
            const linked = document.getElementById(forId);
            if (linked && linked.tagName === 'INPUT') return true;
          }
        }
      }
      return false;
    },
    { timeout: AUTH_INPUT_WAIT_MS },
    TXT_EMAIL,
  );
}

/**
 * Postcondition wait after clicking "Sign In with Password". The
 * password input mounts after a route transition, so the click alone
 * doesn't guarantee the input is in the DOM. Predicate mirrors
 * `fillPassword`'s lookup, including the final `input[type=password]`
 * fallback so labels-stripped re-renders still satisfy the wait.
 */
async function waitForPasswordInput(page: Page): Promise<void> {
  await page.waitForFunction(
    (pwdLabel) => {
      for (const el of document.querySelectorAll('input')) {
        const inp = el as HTMLInputElement;
        if (inp.getAttribute('type') !== 'password') continue;
        const ph = inp.getAttribute('placeholder') || '';
        const aria = inp.getAttribute('aria-label') || '';
        if (ph.includes(pwdLabel) || aria.includes(pwdLabel)) return true;
      }
      for (const labelEl of document.querySelectorAll('label')) {
        const text = labelEl.textContent || '';
        if (text.includes(pwdLabel)) {
          const forId = labelEl.getAttribute('for');
          if (forId) {
            const linked = document.getElementById(forId);
            if (linked && linked.tagName === 'INPUT') return true;
          }
        }
      }
      return document.querySelector('input[type="password"]') !== null;
    },
    { timeout: AUTH_INPUT_WAIT_MS },
    TXT_PASSWORD,
  );
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
  const gdpr = await page.$(SEL_GDPR_CONSENT);
  if (gdpr) {
    await log('Handling GDPR consent...');
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

/**
 * Mighty Networks decorates each privacy-form checkbox with a sibling
 * `span.unchecked-icon` that swaps to `span.checked-icon` once the hidden
 * input is checked. Querying `span.unchecked-icon` therefore doubles as both
 * the click target *and* the post-click assertion (it disappears once
 * checked). If the selector is already absent the checkbox is satisfied —
 * we must not treat that as a failure.
 */
async function clickPrivacyCheckboxIfPresent(
  page: Page,
  selector: string,
  description: string,
  log: LogFn,
): Promise<void> {
  const handle = await page.$(selector);
  if (!handle) {
    await log(`Privacy agreement: ${description} already checked — skipping.`);
    return;
  }
  try {
    await log(`Privacy agreement: checking ${description}...`);
    await handle.click();
  } finally {
    if (typeof handle.dispose === 'function') {
      await handle.dispose();
    }
  }
  /* Postcondition: the unchecked-icon must be gone (class flipped to
   * checked-icon). `hidden: true` covers both "not present" and "not
   * visible", which is the right signal regardless of how MN re-renders. */
  await page.waitForSelector(selector, { hidden: true, timeout: 10_000 });
}

async function handlePrivacyAgreementIfPresent(page: Page, log: LogFn): Promise<boolean> {
  const modal = await page.$(SEL_PRIVACY_AGREEMENT);
  if (!modal) return false;
  if (typeof modal.dispose === 'function') {
    await modal.dispose();
  }
  await log('Privacy agreement page detected — completing form...');

  await clickPrivacyCheckboxIfPresent(page, SEL_PRIVACY_FORM_AGREE, 'I agree', log);
  await clickPrivacyCheckboxIfPresent(page, SEL_PRIVACY_FORM_EMAILS, 'activity emails', log);

  const submit = await page.$(SEL_PRIVACY_FORM_SUBMIT);
  if (!submit) {
    throw new Error('Privacy agreement submit button not found.');
  }
  try {
    await log('Privacy agreement: submitting...');
    try {
      await submit.click();
    } catch (err) {
      /* The submit triggers a navigation away from /onboarding/privacy_agreement;
       * Puppeteer commonly surfaces this as "Execution context was destroyed".
       * That's the success signal, not a failure. */
      if (!isExecutionContextDestroyedError(err)) throw err;
    }
  } finally {
    if (typeof submit.dispose === 'function') {
      await submit.dispose();
    }
  }
  await log('Privacy agreement: submitted.');
  return true;
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
    /* `domcontentloaded` not `networkidle2` — see addSpaceMember.ts for
     * the rationale. The post-goto `waitForSelector(SEL_SIGN_IN, …)`
     * is the real "sign-in form is mounted" signal. Without this fix
     * `goto` would hang the full 30s on the sign-in page too, surfacing
     * as the misleading "Login failed — check credentials" wrapper. */
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    await log('Waiting for app shell...');
    await page.waitForSelector(SEL_SIGN_IN, { timeout: 60_000 });

    /* SEL_SIGN_IN matches at domcontentloaded (router) — the React
     * auth form mounts a beat later. Wait for the email input itself
     * before calling fillEmail, otherwise the one-shot evaluate
     * inside it races the form-mount and throws. */
    await log('Waiting for email input...');
    await waitForEmailInput(page);

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

    /* Same race as the email input — the password input mounts after
     * a route transition, so the click alone doesn't guarantee it's
     * in the DOM. */
    await log('Waiting for password input...');
    await waitForPasswordInput(page);

    await log('Entering password...');
    await fillPassword(page, password);

    await log('Submitting login...');
    await clickFirstWithExactText(page, TXT_NEXT);

    /* The server may insert /onboarding/privacy_agreement between the
     * password submit and the signed-in shell. Wait for whichever lands
     * first, complete the form if needed, then wait for the signed-in
     * shell. */
    await page.waitForFunction(
      ({ signedIn, privacy }) =>
        Boolean(document.querySelector(signedIn)) ||
        Boolean(document.querySelector(privacy)),
      { timeout: 15_000 },
      { signedIn: SEL_SIGNED_IN, privacy: SEL_PRIVACY_AGREEMENT },
    );
    await handlePrivacyAgreementIfPresent(page, log);
    await page.waitForSelector(SEL_SIGNED_IN, { timeout: 30_000 });
    await log('Login confirmed.');
    await rememberProfileAccount(email, log);
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

async function waitForAuthShell(page: Page, log: LogFn): Promise<void> {
  const shellSelectors = {
    signIn: SEL_SIGN_IN,
    signedIn: SEL_SIGNED_IN,
    landing: SEL_LANDING,
    privacy: SEL_PRIVACY_AGREEMENT,
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.waitForFunction(
        ({ signIn, signedIn, landing, privacy }) =>
          Boolean(document.querySelector(signIn)) ||
          Boolean(document.querySelector(signedIn)) ||
          Boolean(document.querySelector(landing)) ||
          Boolean(document.querySelector(privacy)),
        { timeout: AUTH_SHELL_WAIT_MS },
        shellSelectors,
      );
      return;
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
          ({ ready, signIn, signedIn, landing, gdpr, privacy }) => ({
            url: location.href,
            title: document.title,
            bodyClass: document.body?.className ?? '',
            readyFound: Boolean(document.querySelector(ready)),
            signInFound: Boolean(document.querySelector(signIn)),
            signedInFound: Boolean(document.querySelector(signedIn)),
            landingFound: Boolean(document.querySelector(landing)),
            gdprFound: Boolean(document.querySelector(gdpr)),
            privacyFound: Boolean(document.querySelector(privacy)),
          }),
          {
            ready: SEL_READY,
            signIn: SEL_SIGN_IN,
            signedIn: SEL_SIGNED_IN,
            landing: SEL_LANDING,
            gdpr: SEL_GDPR_CONSENT,
            privacy: SEL_PRIVACY_AGREEMENT,
          },
        );
        await log(
          `Auth shell timeout debug: url=${shellState.url} title="${shellState.title}" bodyClass="${shellState.bodyClass}"`,
        );
        await log(
          `Auth shell timeout debug: ready=${shellState.readyFound} signIn=${shellState.signInFound} signedIn=${shellState.signedInFound} landing=${shellState.landingFound} gdpr=${shellState.gdprFound} privacy=${shellState.privacyFound}`,
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
  throw new Error('Timed out waiting for auth shell after retries.');
}

export async function loginIfNeeded(
  page: Page,
  log: LogFn,
  deps: LoginDeps = {},
): Promise<void> {
  await log('Waiting for app shell...');
  await waitForChallengeClearIfPresent(page, log);
  await waitForAuthShell(page, log);

  /* If the server redirected an already-authenticated session to
   * /onboarding/privacy_agreement, we must clear the form *before* the
   * downstream landing/signIn/signedIn dispatch — otherwise none of those
   * shells will match and we fall through to "Unknown authentication
   * state". After the form submits the body class flips to
   * communities-app, so re-run the shell wait. */
  if (await handlePrivacyAgreementIfPresent(page, log)) {
    await waitForAuthShell(page, log);
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
    await rememberProfileAccount(process.env.MN_EMAIL, log);
    return;
  }

  throw new Error('Unknown authentication state: neither sign-in nor signed-in shell detected.');
}
