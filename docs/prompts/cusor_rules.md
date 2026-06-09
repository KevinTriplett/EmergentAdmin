You are building a local Puppeteer automation tool for Mighty Networks.

Rules:
- Never hardcode credentials. Always read from process.env.
- Never use page.waitForTimeout() as a substitute for real DOM condition
  checks. Always wait for a specific selector or network idle state.
- Every Puppeteer interaction must be wrapped in try/catch with a
  descriptive error message sent to the WebSocket logger via the
  log() callback.
- All task functions accept a `log` callback and an `abortSignal`
  object. Use log() for all user-facing output. Check abortSignal
  between loop iterations.
- CSS selector strings must be stored as named constants at the top
  of each file, grouped under a comment:
  // === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
- Text-match strings used for clicking elements by visible text must
  also be stored as named constants under:
  // === TEXT LABELS — UPDATE THESE IF MN CHANGES ITS UI TEXT ===
- All tasks return { success: boolean, removed?: number, error?: string }.
- Never assume a click succeeded. After every state-changing click,
  assert that the expected DOM change occurred before proceeding.
- After removing a member, verify the first row has changed (stale
  guard) before continuing the loop. If the same member is still at
  index 0, halt immediately.
- Browser lifecycle is per-task: launch before, close in finally.
  No singleton browser instance.
- When locating elements by visible text, use XPath or page.evaluate
  to find the element. Do not rely on selectors alone when the
  identifying feature is the text content.
- Safe defaults: headless=true, dryRun=true. The user must
  explicitly opt into destructive + visible modes.
- Use TypeScript not Javascript
