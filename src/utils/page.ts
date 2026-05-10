import type { Page } from 'puppeteer';

/**
 * Shared Puppeteer page primitives used across the task modules.
 *
 * `domClick` was previously inlined per task (with two different
 * variants: wait-then-click in addSpaceMember, click-immediately in
 * removeSpaceMembers). All callers now use the wait-then-click form;
 * the redundant pre-click `waitForSelector` is a no-op when the
 * preceding step's postcondition already established the selector,
 * and a real robustness win when it didn't (e.g. a modal region
 * confirms the modal is open but not necessarily that the confirm
 * button has finished mounting).
 */

/**
 * Wait until at least one element matching `selector` exists in the
 * document. Resolves on first hit; rejects (Puppeteer TimeoutError) at
 * `timeoutMs`.
 *
 * Why `waitForFunction` rather than `page.waitForSelector`? The two are
 * close to equivalent for presence checks, but `waitForFunction` has
 * proven more robust against Mighty Networks' habit of mounting an
 * element in a hidden state before its trigger animation finishes:
 * `waitForSelector` without `visible: true` resolves immediately on
 * presence, while `waitForFunction` re-runs every animation frame and
 * is what both call sites converged on. Keep the shape identical to
 * the original copies in the task files so an in-place refactor is a
 * no-op behaviorally.
 */
export async function waitForSelector(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (sel) => document.querySelector(sel) !== null,
    { timeout: timeoutMs },
    selector,
  );
}

/**
 * Wait until `selector` is present *and* visible (non-zero bounds, not
 * `display:none` / `visibility:hidden`). Needed when a trigger opens
 * an animated container: the inner element is often already in the
 * DOM before the animation begins, so a plain presence check returns
 * a stale/hidden instance that isn't yet interactable.
 */
export async function waitForVisible(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  await page.waitForSelector(selector, { timeout: timeoutMs, visible: true });
}

/**
 * Default wait used by `domClick` before it tries to click. Long enough
 * to ride out MN's typical animation delays without delaying the
 * explicit failure path significantly. Each caller can override via
 * `waitMs` when a different budget is appropriate.
 */
const DEFAULT_DOM_CLICK_WAIT_MS = 15_000;

/**
 * DOM click on a selector. MN controls do not reliably respond to
 * Puppeteer pointer clicks, so we drive `HTMLElement.click()`
 * directly via `page.evaluate`.
 *
 * The pre-click `waitForSelector` is what makes this safe to call
 * from anywhere: callers don't have to remember whether the previous
 * step's postcondition already established this selector. Failure
 * mode is a `TimeoutError` with the selector named, which the
 * caller's outer try/catch surfaces in the run log.
 *
 * `label` is what shows up in the "selector not found" thrown error
 * — pass a human-friendly action name like "Member action menu" or
 * "Sort by Last Active" so log lines read naturally.
 */
export async function domClick(
  page: Page,
  selector: string,
  label: string,
  waitMs: number = DEFAULT_DOM_CLICK_WAIT_MS,
): Promise<void> {
  await waitForSelector(page, selector, waitMs);
  const found = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!found) throw new Error(`${label}: selector not found (${selector})`);
}
