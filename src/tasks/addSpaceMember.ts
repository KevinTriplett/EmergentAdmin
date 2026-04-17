import type { Page } from 'puppeteer';
import { loginIfNeeded, type LogFn } from '../auth.js';
import { SPACE_IDS } from './removeSpaceMembers.js';

// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_MEMBER_SEARCH = ".filter-bar-search-region div[aria-label='Search Members']";
const SEL_MEMBER_SEARCH_INPUT = ".filter-bar-search-region div[aria-label='Search Members'] input";
const SEL_MEMBER_ROW = (memberId: string): string => `[data-member-item='${memberId}']`;
const SEL_MEMBER_DROPDOWN = (memberId: string): string =>
  `[data-member-item='${memberId}'] .actions-region a.mighty-drop-down-toggle`;
const SEL_ADD_MEMBER_TO_SPACE = 'a#menu-list-item-add-to-spaces';
const SEL_SPACE_LIST_INPUT = ".MuiPaper-root input[placeholder='Choose Spaces']";
/**
 * clarifications.md line 70 suggests `".MuiPopper-root li:firstchild"`, but position-based
 * matching is wrong here: MUI's Autocomplete renders a transient "Loading…" / empty-state
 * `<li>` before the filtered options arrive, and `:first-child` would pick that up. Space
 * names are unique in this community, so we match the option by text against
 * `fullSpaceName` and wait until a matching li exists in the popper.
 */
const SEL_SPACE_LIST_OPTIONS = '.MuiPopper-root li';
/**
 * After selecting an option, MUI renders it as a chip (tag) inside the input.
 * Waiting for the tag containing `fullSpaceName` to appear is the true
 * postcondition of "the space was successfully picked"; without it a no-op
 * click on a stale option looks indistinguishable from success until the
 * final confirm fails far downstream.
 */
const SEL_SPACE_TAG = '.MuiBox-root .MuiAutocomplete-tag';
const SEL_SPACE_LIST_CLOSE = ".MuiPaper-root button[title='Open']";
const SEL_ADD_TO_SPACE_BUTTON = ".MuiPaper-root button[data-id='dialog-confirm-button']";
const SEL_TOAST_SUCCESS = '.notifyjs-corner .system-toast-inner.success';

// === URLS ===
const MEMBERS_URL = 'https://emergent-commons.mn.co/admin/members/all';
const spaceUrl = (spaceId: string): string =>
  `https://emergent-commons.mn.co/spaces/${spaceId}/admin/members/all`;

// === TIMING CONSTANTS ===
const WAIT_READY_MS = 60_000;
const WAIT_SHORT_MS = 15_000;
const WAIT_POPPER_MS = 8000;
const WAIT_TOAST_MS = 10_000;
const SEARCH_DEBOUNCE_MS = 1500;
/**
 * MN's search input and MUI Autocomplete animate in after their trigger is
 * clicked. Puppeteer's `waitForSelector({ visible: true })` resolves as soon as
 * the element is in the DOM and has non-zero bounds, but the expansion may
 * still be in progress. Sleeping this long after visibility lets the animation
 * settle so keystrokes all land in the final, focused input instance instead
 * of racing against a reparent / remount.
 */
const ANIMATION_SETTLE_MS = 400;
/** Per-keystroke delay used with `page.keyboard.type` to stay well under MN's input-handling rate. */
const KEYSTROKE_DELAY_MS = 30;

// === TEXT FRAGMENTS ===
const TOAST_FRAGMENT = 'will be added';
const ALREADY_A_MEMBER = 'Already a member';
const ABORTED_BY_USER = 'Aborted by user';

export type LogLevel = 'light' | 'debug';
const DEFAULT_LOG_LEVEL: LogLevel =
  process.env.ADD_MEMBER_LOG_LEVEL === 'debug' ? 'debug' : 'light';

const msg = {
  unknownSpace: (name: string) => `Unknown space: "${name}".`,
  missingArg: (name: string) => `${name} is required.`,
  checkingMembership: (name: string, space: string) =>
    `Checking whether "${name}" is already in "${space}"…`,
  alreadyMember: (name: string, space: string) =>
    `"${name}" is already in "${space}"; nothing to do.`,
  adding: (name: string, space: string) => `Adding "${name}" to "${space}"…`,
  added: (name: string, space: string) => `Added "${name}" to "${space}".`,
  searchingFor: (name: string) => `Searching for member: ${name}…`,
  typingSpaceName: (space: string) => `Typing space name: ${space}…`,
  clicking: (label: string) => `Clicking ${label}…`,
  awaitingSpaceTag: (space: string) =>
    `Waiting for "${space}" tag to appear in the space list…`,
  abortedByUser: () => ABORTED_BY_USER,
  toastTimeout: (ms: number) =>
    `Success toast "${TOAST_FRAGMENT}" did not appear within ${ms}ms.`,
  spaceTagMissing: (space: string, ms: number) =>
    `"${space}" tag did not appear in the space list within ${ms}ms.`,
} as const;

export type AddSpaceMemberArgs = {
  page: Page;
  fullMemberName: string;
  memberId: string;
  fullSpaceName: string;
  log: LogFn;
  abortSignal: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
  logLevel?: LogLevel;
};

export type AddSpaceMemberResult = {
  success: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

async function waitForSelector(page: Page, selector: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (sel) => document.querySelector(sel) !== null,
    { timeout: timeoutMs },
    selector,
  );
}

/**
 * Wait for a selector to be present *and* visible (non-zero bounds, not
 * `display:none` / `visibility:hidden`). Needed when a trigger opens an
 * animated container: the inner element is often already in the DOM before
 * the animation begins, so a plain presence check returns a stale/hidden
 * instance that isn't yet interactable.
 */
async function waitForVisible(page: Page, selector: string, timeoutMs: number): Promise<void> {
  await page.waitForSelector(selector, { timeout: timeoutMs, visible: true });
}

/** DOM click on a selector. MN controls do not reliably respond to Puppeteer pointer clicks. */
async function domClick(page: Page, selector: string, label: string): Promise<void> {
  const found = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!found) throw new Error(`${label}: selector not found (${selector})`);
}

/**
 * Type into an input using real keystrokes via Puppeteer's keyboard.
 *
 * Why not a scripted `el.value = val` + dispatch? Two traps converge on MN's
 * search and MUI Autocomplete inputs:
 *
 *   1. Animation race. The input is often mounted in a collapsed/hidden state
 *      before its trigger is clicked. A scripted assignment writes into that
 *      stale instance, which gets reparented or visually replaced as the
 *      animation expands, wiping the value. Real keystrokes delivered over
 *      time land on whichever element has focus *at that moment*, so the
 *      later characters land on the settled input regardless.
 *
 *   2. React's `_valueTracker`. React compares `input.value` against a hidden
 *      tracker; if they match, `onChange` is skipped. A direct `el.value = x`
 *      updates the tracker in lock-step, so the dispatched `input` event
 *      triggers no diff. `page.keyboard.type` produces native InputEvents that
 *      go through React's event system normally.
 */
async function keyboardType(page: Page, selector: string, value: string, label: string): Promise<void> {
  try {
    await page.focus(selector);
  } catch {
    throw new Error(`${label}: input not focusable (${selector})`);
  }
  await page.keyboard.type(value, { delay: KEYSTROKE_DELAY_MS });
}

async function disposeHandle(
  handle: { dispose?: () => Promise<void> } | null,
): Promise<void> {
  if (!handle) return;
  if (typeof handle.dispose === 'function') {
    await handle.dispose().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Debug diagnostics (observational only — never alter behavior)
// ---------------------------------------------------------------------------

type SelectorSnapshot = {
  count: number;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
};

async function snapshotSelector(page: Page, selector: string): Promise<SelectorSnapshot> {
  return page.evaluate((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    const first = nodes[0] as HTMLElement | undefined;
    if (!first) return { count: 0, visible: false, rect: null };
    const rect = first.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    return {
      count: nodes.length,
      visible,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }, selector);
}

async function logSnapshot(page: Page, selector: string, log: LogFn, stage: string): Promise<void> {
  const s = await snapshotSelector(page, selector);
  await log(
    `DIAG ${stage}: selector="${selector}" count=${s.count} visible=${s.visible} rect=${JSON.stringify(s.rect)}`,
  );
}

// ---------------------------------------------------------------------------
// Step functions — each: resolve → action → assert postcondition
// ---------------------------------------------------------------------------

async function searchForMember(
  page: Page, fullMemberName: string, log: LogFn, logLevel: LogLevel,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  await log(msg.searchingFor(fullMemberName));
  await domClick(page, SEL_MEMBER_SEARCH, 'Member search');

  try {
    await waitForVisible(page, SEL_MEMBER_SEARCH_INPUT, WAIT_SHORT_MS);
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_MEMBER_SEARCH_INPUT, log, 'searchForMember-postcondition-failed');
    }
    throw new Error('Member search opened but the search input did not appear');
  }

  await sleep(ANIMATION_SETTLE_MS);
  await keyboardType(page, SEL_MEMBER_SEARCH_INPUT, fullMemberName, 'Member search input');
}

/**
 * After the search has been submitted, wait out the client-side debounce and
 * then check whether a row matching `memberId` is present. The `$` probe keeps
 * this path a single, explicit point-in-time check — no race, no retries.
 */
async function isAlreadyAMember(
  page: Page, memberId: string, sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  await sleep(SEARCH_DEBOUNCE_MS);
  const handle = await page.$(SEL_MEMBER_ROW(memberId));
  if (!handle) return false;
  await disposeHandle(handle);
  return true;
}

async function openMemberMenu(
  page: Page, memberId: string, log: LogFn, logLevel: LogLevel,
): Promise<void> {
  await waitForSelector(page, SEL_MEMBER_ROW(memberId), WAIT_SHORT_MS);
  await log(msg.clicking('member action menu'));
  await domClick(page, SEL_MEMBER_DROPDOWN(memberId), 'Member action menu');

  try {
    await waitForSelector(page, SEL_ADD_MEMBER_TO_SPACE, WAIT_SHORT_MS);
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_ADD_MEMBER_TO_SPACE, log, 'openMemberMenu-postcondition-failed');
    }
    throw new Error('Member action menu opened but "Add to spaces" did not appear');
  }
}

async function openAddToSpacesDialog(
  page: Page, log: LogFn, logLevel: LogLevel,
): Promise<void> {
  await log(msg.clicking('Add to spaces'));
  await domClick(page, SEL_ADD_MEMBER_TO_SPACE, 'Add to spaces');

  try {
    await waitForVisible(page, SEL_SPACE_LIST_INPUT, WAIT_SHORT_MS);
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_SPACE_LIST_INPUT, log, 'openAddToSpacesDialog-postcondition-failed');
    }
    throw new Error('"Add to spaces" clicked but the space picker did not appear');
  }
}

async function pickSpaceInDialog(
  page: Page, fullSpaceName: string, log: LogFn, logLevel: LogLevel,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  await log(msg.typingSpaceName(fullSpaceName));
  await sleep(ANIMATION_SETTLE_MS);
  await keyboardType(page, SEL_SPACE_LIST_INPUT, fullSpaceName, 'Space list input');

  /* Wait until the popper contains a li whose visible text matches fullSpaceName.
   * This is a stricter postcondition than "any li exists" — it rules out MUI's
   * transient "Loading…" placeholder and the brief window between keystrokes
   * finishing and the filter producing its first real match. */
  try {
    await page.waitForFunction(
      (listSel: string, expected: string) => {
        const needle = expected.trim().toLowerCase();
        const items = Array.from(document.querySelectorAll(listSel));
        return items.some((li) => (li.textContent || '').trim().toLowerCase().includes(needle));
      },
      { timeout: WAIT_POPPER_MS },
      SEL_SPACE_LIST_OPTIONS,
      fullSpaceName,
    );
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_SPACE_LIST_OPTIONS, log, 'pickSpaceInDialog-option-not-found');
    }
    throw new Error(`No space option matching "${fullSpaceName}" appeared within ${WAIT_POPPER_MS}ms`);
  }

  await log(msg.clicking(`space option "${fullSpaceName}"`));
  const clicked = await page.evaluate(
    (listSel: string, expected: string) => {
      const needle = expected.trim().toLowerCase();
      const items = Array.from(document.querySelectorAll(listSel));
      const match = items.find((li) => (li.textContent || '').trim().toLowerCase().includes(needle));
      if (!match) return false;
      (match as HTMLElement).click();
      return true;
    },
    SEL_SPACE_LIST_OPTIONS,
    fullSpaceName,
  );
  if (!clicked) {
    throw new Error(`Matching space option disappeared before it could be clicked: "${fullSpaceName}"`);
  }

  /* Postcondition for "the click actually selected the space": the picker now
   * shows a visible MuiAutocomplete-tag whose text contains fullSpaceName.
   * Without this check, a no-op click on a stale option is indistinguishable
   * from success until the confirm step fails downstream. */
  await log(msg.awaitingSpaceTag(fullSpaceName));
  try {
    await page.waitForFunction(
      (tagSel: string, expected: string) => {
        const needle = expected.trim().toLowerCase();
        const tags = Array.from(document.querySelectorAll(tagSel));
        return tags.some((t) => {
          const rect = (t as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          return (t.textContent || '').trim().toLowerCase().includes(needle);
        });
      },
      { timeout: WAIT_POPPER_MS },
      SEL_SPACE_TAG,
      fullSpaceName,
    );
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_SPACE_TAG, log, 'pickSpaceInDialog-tag-not-visible');
    }
    throw new Error(msg.spaceTagMissing(fullSpaceName, WAIT_POPPER_MS));
  }

  /* NOTE: clarifications.md step "click SEL_SPACE_LIST_CLOSE" is currently skipped.
   * In practice the picker auto-collapses once the confirm button click fires, and
   * the close toggle (".MuiPaper-root button[title='Open']") was not found in the
   * DOM at this point anyway. If we need to reinstate it later, restore a
   * `domClick(page, SEL_SPACE_LIST_CLOSE, 'Space list close')` call here. */
}

async function confirmAddAndAwaitToast(
  page: Page, log: LogFn, logLevel: LogLevel,
): Promise<void> {
  await log(msg.clicking('Add to space confirm'));
  await domClick(page, SEL_ADD_TO_SPACE_BUTTON, 'Add-to-space confirm');

  try {
    await page.waitForFunction(
      (sel, frag) => {
        const el = document.querySelector(sel);
        return el ? (el.textContent || '').includes(frag) : false;
      },
      { timeout: WAIT_TOAST_MS },
      SEL_TOAST_SUCCESS,
      TOAST_FRAGMENT,
    );
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_TOAST_SUCCESS, log, 'confirmAddAndAwaitToast-toast-timeout');
    }
    throw new Error(msg.toastTimeout(WAIT_TOAST_MS));
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function performAdd(
  page: Page,
  fullMemberName: string,
  memberId: string,
  fullSpaceName: string,
  log: LogFn,
  logLevel: LogLevel,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  await searchForMember(page, fullMemberName, log, logLevel, sleep);
  await openMemberMenu(page, memberId, log, logLevel);
  await openAddToSpacesDialog(page, log, logLevel);
  await pickSpaceInDialog(page, fullSpaceName, log, logLevel, sleep);
  await confirmAddAndAwaitToast(page, log, logLevel);
}

async function logAbortAndReturn(log: LogFn): Promise<AddSpaceMemberResult> {
  await log(msg.abortedByUser());
  return { success: true, error: ABORTED_BY_USER };
}

async function logErrorAndFail(log: LogFn, error: string): Promise<AddSpaceMemberResult> {
  await log(`ERROR: ${error}`);
  return { success: false, error };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function addSpaceMember({
  page, fullMemberName, memberId, fullSpaceName, log, abortSignal,
  sleep: sleepArg, logLevel = DEFAULT_LOG_LEVEL,
}: AddSpaceMemberArgs): Promise<AddSpaceMemberResult> {
  const sleep = sleepArg ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (!fullMemberName || !fullMemberName.trim()) {
    return { success: false, error: msg.missingArg('fullMemberName') };
  }
  if (!memberId || !memberId.trim()) {
    return { success: false, error: msg.missingArg('memberId') };
  }
  const spaceId = SPACE_IDS[fullSpaceName];
  if (!spaceId || !fullSpaceName.trim()) {
    return { success: false, error: msg.unknownSpace(fullSpaceName) };
  }

  if (abortSignal.aborted) return logAbortAndReturn(log);

  try {
    // --- Phase 1: on the space members page, check "already a member" ---
    await log(msg.checkingMembership(fullMemberName, fullSpaceName));
    await page.goto(spaceUrl(spaceId), { waitUntil: 'networkidle2' });
    await loginIfNeeded(page, log);
    await page.waitForSelector(SEL_READY, { timeout: WAIT_READY_MS });

    if (abortSignal.aborted) return logAbortAndReturn(log);

    await searchForMember(page, fullMemberName, log, logLevel, sleep);
    if (await isAlreadyAMember(page, memberId, sleep)) {
      await log(msg.alreadyMember(fullMemberName, fullSpaceName));
      return { success: true, error: ALREADY_A_MEMBER };
    }

    if (abortSignal.aborted) return logAbortAndReturn(log);

    // --- Phase 2: on the global members page, add the member to the space ---
    await log(msg.adding(fullMemberName, fullSpaceName));
    await page.goto(MEMBERS_URL, { waitUntil: 'networkidle2' });
    await loginIfNeeded(page, log);
    await page.waitForSelector(SEL_READY, { timeout: WAIT_READY_MS });

    if (abortSignal.aborted) return logAbortAndReturn(log);

    await performAdd(page, fullMemberName, memberId, fullSpaceName, log, logLevel, sleep);

    await log(msg.added(fullMemberName, fullSpaceName));
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return logErrorAndFail(log, message);
  }
}
