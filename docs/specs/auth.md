# Agent Prompt: auth.ts

Build `src/auth.ts` for a Puppeteer automation project.

## Exports

```js
async function login(page, log)
```

## Constants

```js
// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_SIGN_IN = 'body.auth-sign_in';
const SEL_LANDING = 'body.communities-landing';
const SEL_GDPR_CONSENT = '#c-p-bn';
const SEL_SIGNED_IN = 'body.communities-app';
const SEL_PRIVACY_AGREEMENT = 'body.onboarding-privacy_agreement';
const SEL_PRIVACY_FORM_AGREE = 'label.privacy-form-agree span.unchecked-icon';
const SEL_PRIVACY_FORM_EMAILS = 'label.privacy-form-activity-emails-agree span.unchecked-icon';
const SEL_PRIVACY_FORM_SUBMIT = ".privacy-agreement-form button[type='button-submit']";

// === TEXT LABELS — UPDATE THESE IF MN CHANGES ITS UI TEXT ===
const TXT_LANDING_SIGN_IN = 'Sign In';
const TXT_EMAIL = 'Email';
const TXT_NEXT = 'Next';
const TXT_SIGN_IN_WITH_PASSWORD = 'Sign In with Password';
const TXT_PASSWORD = 'Password';
```

## Login URL

```
https://emergent-commons.mn.co/sign_in
```

Read `MN_EMAIL` and `MN_PASSWORD` from `process.env`. Never store or
export credentials.

## Login Flow

1. Navigate to the login URL.
2. Wait until `SEL_READY` AND `SEL_SIGN_IN` are both present.
3. GDPR consent: check if `SEL_GDPR_CONSENT` exists. If it does,
   click it. If not, skip (it only appears on first visit or cleared
   cookies). Do not throw if absent.
4. Wait (up to 30 seconds) for an email input to appear in the DOM.
   `SEL_SIGN_IN` (`body.auth-sign_in`) is set by MN's router at
   `domcontentloaded`, *before* the React auth form has rendered, so
   matching that selector alone is not enough — `fillEmail`'s
   one-shot `evaluate` would race the form-mount and throw
   `"email input not found"`. The predicate must mirror the
   placeholder / aria-label / `<label for=…>` lookup used by
   `fillEmail` so the wait's success means `fillEmail` will succeed.
5. Find the input element whose associated label or placeholder text
   is `TXT_EMAIL`. Fill it with `process.env.MN_EMAIL`.
6. Click the element whose visible text is `TXT_NEXT`.
7. Wait for the "Sign In with Password" link to appear. Click the
   element whose visible text is `TXT_SIGN_IN_WITH_PASSWORD`.
8. Wait (up to 30 seconds) for a password input to appear in the DOM
   (same rationale as step 4 — the click triggers a route transition
   and the password input mounts a beat later). Predicate must mirror
   `fillPassword`'s lookup, including its `input[type=password]`
   fallback.
9. Find the input element whose associated label or placeholder text
   is `TXT_PASSWORD`. Fill it with `process.env.MN_PASSWORD`.
10. Click the element whose visible text is `TXT_NEXT`.
11. Wait (max 15 seconds) for either `SEL_SIGNED_IN` **or**
    `SEL_PRIVACY_AGREEMENT` to appear. If neither appears, throw:
    `"Login failed — check credentials or MN_COMMUNITY_URL in .env"`
12. Run the privacy-agreement handler (see below). It is a no-op when
    `SEL_PRIVACY_AGREEMENT` is absent.
13. Wait for `SEL_SIGNED_IN` (max 30 seconds).

## Privacy Agreement Handler

Mighty Networks may insert
`https://emergent-commons.mn.co/onboarding/privacy_agreement` either
immediately after a successful login or — for an already-authenticated
session — as the first page returned when navigating to any admin URL.
The handler MUST be invoked in both places:

- Inside `login()` after the password submit (step 12 above).
- Inside `loginIfNeeded()` right after the app shell wait, *before*
  dispatching to the landing / sign-in / signed-in branches.

Algorithm (run only when `SEL_PRIVACY_AGREEMENT` is present):

1. If `SEL_PRIVACY_FORM_AGREE` is present, click it and wait for that
   selector to disappear (the icon swaps from `unchecked-icon` to
   `checked-icon`). If absent, the checkbox is already satisfied — skip.
2. Repeat step 1 for `SEL_PRIVACY_FORM_EMAILS`.
3. Click `SEL_PRIVACY_FORM_SUBMIT`. If the click destroys the execution
   context, treat that as the navigation success signal — do not throw.
4. If `SEL_PRIVACY_FORM_SUBMIT` is not found while the modal is present,
   throw `"Privacy agreement submit button not found."`.

Inside `loginIfNeeded()`, if the handler reports that the form was
submitted, re-run the app-shell wait so the subsequent body-class checks
see the new (`communities-app`) shell.

## Logging

Call `log()` at each numbered step with a status string:
- `"Navigating to login page..."`
- `"Handling GDPR consent..."` or `"No GDPR consent dialog — skipping"`
- `"Waiting for email input..."`
- `"Entering email..."`
- `"Clicking Next..."`
- `"Selecting password sign-in..."`
- `"Waiting for password input..."`
- `"Entering password..."`
- `"Submitting login..."`
- `"Privacy agreement page detected — completing form..."` (only when present)
- `"Privacy agreement: checking <description>..."` / `"... already checked — skipping."`
- `"Privacy agreement: submitting..."` then `"Privacy agreement: submitted."`
- `"Login confirmed."` or throw on failure

## Conditional Login Helper

Export a second function for use by tasks:

```js
async function loginIfNeeded(page, log)
```

- Check if `SEL_SIGN_IN` is present on the current page.
- If yes: call `login(page, log)`.
- If no: call `log("Already logged in — skipping login.")` and return.

This allows tasks to call `loginIfNeeded` after navigating to their
target page, handling both fresh sessions and existing sessions.

## Return

```js
{ success: true }
```
On failure, throw an Error (caller handles it).

## Error Handling

Wrap all DOM interactions in try/catch. On catch, call `log()` with
the error message, then re-throw so the calling task can handle
cleanup.
