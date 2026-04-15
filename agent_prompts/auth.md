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
const SEL_GDPR_CONSENT = '#c-p-bn';
const SEL_SIGNED_IN = 'body.communities-app';

// === TEXT LABELS — UPDATE THESE IF MN CHANGES ITS UI TEXT ===
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
4. Find the input element whose associated label or placeholder text
   is `TXT_EMAIL`. Fill it with `process.env.MN_EMAIL`.
5. Click the element whose visible text is `TXT_NEXT`.
6. Wait for the "Sign In with Password" link to appear. Click the
   element whose visible text is `TXT_SIGN_IN_WITH_PASSWORD`.
7. Find the input element whose associated label or placeholder text
   is `TXT_PASSWORD`. Fill it with `process.env.MN_PASSWORD`.
8. Click the element whose visible text is `TXT_NEXT`.
9. Wait for `SEL_SIGNED_IN` to appear (max 15 seconds). If it does
   not appear, throw:
   `"Login failed — check credentials or MN_COMMUNITY_URL in .env"`

## Logging

Call `log()` at each numbered step with a status string:
- `"Navigating to login page..."`
- `"Handling GDPR consent..."` or `"No GDPR consent dialog — skipping"`
- `"Entering email..."`
- `"Clicking Next..."`
- `"Selecting password sign-in..."`
- `"Entering password..."`
- `"Submitting login..."`
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
