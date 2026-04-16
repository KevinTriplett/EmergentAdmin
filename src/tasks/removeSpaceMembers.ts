import type { ElementHandle, Page } from 'puppeteer';
import { loginIfNeeded, type LogFn } from '../auth.js';
import { abortedRemovalMessage } from '../abortRemoval.js';

// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_FLYOUT = '#flyout-main-content';
const SEL_TABLE_MEMBERS = '.all-members-list-items';
const SEL_MEMBER_ROW = '[data-member-item]';
const SEL_MEMBER_DROPDOWN = '.actions-region a.mighty-drop-down-toggle';
const SEL_MEMBER_DROPDOWN_MORE = '#menu-list-item-more-host-FlexSpace-actions .toggle-child-expanded-button';
const SEL_REMOVE_FROM_SPACE = '#menu-list-item-remove-from-sub-space';
const SEL_MODAL_CONFIRM = '#modal-content-region .modal-confirm-button';
const SEL_MODAL_CANCEL = '#modal-content-region .modal-reject-button';
const SEL_MODAL_REGION = '#modal-content-region';

// === SPACE IDS — Maps display name to MN space ID ===
export const SPACE_IDS: Record<string, string> = {
  '1. Relating to SELF': '7330330',
  '2. Relating to OTHERS': '7330338',
  '3. Relating to WORLD': '7330342',
  '4. Current Events/Politics/Hot Buttons': '7330344',
  '5. News/Ideas from Crews, Teams, Events': '5285007',
  '6. Personal Introductions': '4748980',
  '7. EC Announcements and Highlights': '4747426',
  '8. Miscellaneous': '9325627',
  'Creative Center': '5722465',
  Marketplace: '5627234',
  Playground: '23462808',
};

// === ADMIN IDS — Never remove these members ===
const ADMIN_IDS = ['7698608', '12314607'];

const SCROLL_LOAD_MS = 3000;
const SCROLL_MAX_RETRIES = 5;
const WAIT_SHORT_MS = 15_000;
const WAIT_ROW_UPDATE_MS = 30_000;
const OPTIONAL_ACK_TIMEOUT_MS = 1200;
const DRY_RUN_SETTLE_WAIT_MS = 1200;
const DRY_RUN_SETTLE_FALLBACK_SLEEP_MS = 500;

export type LogLevel = 'light' | 'debug';
const DEFAULT_LOG_LEVEL: LogLevel =
  process.env.REMOVE_MEMBERS_LOG_LEVEL === 'debug' ? 'debug' : 'light';

function memberRef(name: string, memberId: string): string {
  return `${name} (member ${memberId})`;
}

function pluralSuffix(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

const msg = {
  unknownSpace: (name: string) => `Unknown space: "${name}".`,
  memberListLoaded: (space: string, count: number) => `Member list loaded for "${space}" (${count} rows).`,
  dryRunNoRemovals: () => 'Dry run: no members will actually be removed.',
  abortAfterRemovals: (n: number) =>
    `Abort requested; stopping after ${n} removal${pluralSuffix(n, '', 's')}.`,
  dryRunWouldRemove: (name: string, memberId: string) =>
    `Dry run: would remove ${memberRef(name, memberId)}.`,
  removingMember: (name: string, memberId: string) =>
    `Removing ${memberRef(name, memberId)}.`,
  removalComplete: (ordinal: number, name: string) =>
    `Removal ${ordinal} complete: ${name}.`,
  removalNotConfirmed: (name: string, memberId: string) =>
    `Removal not confirmed: ${memberRef(name, memberId)} is still in the member list. MN may have rejected the removal.`,
  clicking: (label: string) => `Clicking ${label}…`,
} as const;

export type RemoveSpaceMembersArgs = {
  page: Page;
  fullSpaceName: string;
  dryRun?: boolean;
  log: LogFn;
  abortSignal: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
  logLevel?: LogLevel;
};

export type RemoveSpaceMembersResult = {
  success: boolean;
  removed: number;
  error?: string;
};

type RowMeta = { memberId: string; name: string };

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

async function readRowMeta(row: ElementHandle<Element>): Promise<RowMeta> {
  return row.evaluate((el) => {
    const memberId = el.getAttribute('data-member-item') ?? '';
    const link = (el.querySelector('a.navigate[href]') as HTMLAnchorElement) || null;
    const name = link?.getAttribute('title')?.trim() || link?.textContent?.trim() || '';
    return { memberId, name };
  });
}

async function waitForSelector(page: Page, selector: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (sel) => document.querySelector(sel) !== null,
    { timeout: timeoutMs },
    selector,
  );
}

async function waitForSelectorAbsent(page: Page, selector: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (sel) => document.querySelector(sel) === null,
    { timeout: timeoutMs },
    selector,
  );
}

/** DOM click on a selector. MN menu/modal controls do not respond to Puppeteer pointer clicks. */
async function domClick(page: Page, selector: string, label: string): Promise<void> {
  const found = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!found) throw new Error(`${label}: selector not found (${selector})`);
}

/** DOM click scoped to a member row. */
async function domClickInRow(page: Page, memberId: string, selector: string, label: string): Promise<void> {
  const rowSelector = `${SEL_MEMBER_ROW}[data-member-item="${memberId}"]`;
  const found = await page.evaluate(
    ({ rowSel, childSel }) => {
      const row = document.querySelector(rowSel) as HTMLElement | null;
      if (!row) return false;
      const el = row.querySelector(childSel) as HTMLElement | null;
      if (!el) return false;
      el.click();
      return true;
    },
    { rowSel: rowSelector, childSel: selector },
  );
  if (!found) throw new Error(`${label}: row or control not found (row=${rowSelector}, control=${selector})`);
}

async function disposeHandle(handle: ElementHandle<Element> | null): Promise<void> {
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
  await log(`DIAG ${stage}: selector="${selector}" count=${s.count} visible=${s.visible} rect=${JSON.stringify(s.rect)}`);
}

// ---------------------------------------------------------------------------
// Removal step functions — each: wait → click → assert postcondition
// ---------------------------------------------------------------------------

async function openMemberMenu(
  page: Page, memberId: string, log: LogFn, logLevel: LogLevel,
): Promise<void> {
  const rowSelector = `${SEL_MEMBER_ROW}[data-member-item="${memberId}"]`;
  await waitForSelector(page, rowSelector, WAIT_SHORT_MS);
  await log(msg.clicking('member action menu'));
  await domClickInRow(page, memberId, SEL_MEMBER_DROPDOWN, 'Member action menu');

  try {
    await waitForSelector(page, SEL_MEMBER_DROPDOWN_MORE, WAIT_SHORT_MS);
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_MEMBER_DROPDOWN_MORE, log, 'openMemberMenu-postcondition-failed');
    }
    throw new Error('Member action menu opened but More actions control did not appear');
  }
}

async function expandMoreActions(
  page: Page, log: LogFn, logLevel: LogLevel,
): Promise<void> {
  if (logLevel === 'debug') {
    await logSnapshot(page, SEL_MEMBER_DROPDOWN_MORE, log, 'before-more-click');
  }
  await log(msg.clicking('more actions control'));
  await domClick(page, SEL_MEMBER_DROPDOWN_MORE, 'More actions');

  try {
    await waitForSelector(page, SEL_REMOVE_FROM_SPACE, WAIT_SHORT_MS);
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_REMOVE_FROM_SPACE, log, 'expandMore-postcondition-failed');
    }
    throw new Error('More actions expanded but Remove from space did not appear');
  }
}

async function clickRemoveFromSpace(
  page: Page, log: LogFn, logLevel: LogLevel,
): Promise<void> {
  await log(msg.clicking('Remove from space'));
  await domClick(page, SEL_REMOVE_FROM_SPACE, 'Remove from space');

  try {
    await waitForSelector(page, SEL_MODAL_REGION, WAIT_SHORT_MS);
  } catch {
    if (logLevel === 'debug') {
      await logSnapshot(page, SEL_MODAL_REGION, log, 'removeFromSpace-postcondition-failed');
    }
    throw new Error('Remove from space clicked but confirmation modal did not appear');
  }
}

async function dismissDryRunModal(page: Page, log: LogFn): Promise<void> {
  await log(msg.clicking('cancel'));
  const clicked = await page.evaluate(
    ({ cancelSel, regionSel }) => {
      const modal = document.querySelector(regionSel);
      if (!modal) return false;
      const cancel = modal.querySelector(cancelSel.split(' ').pop()!) as HTMLElement | null;
      if (cancel) { cancel.click(); return true; }
      const fallback = modal.querySelector('button, [role="button"], a') as HTMLElement | null;
      if (fallback) { fallback.click(); return true; }
      return false;
    },
    { cancelSel: SEL_MODAL_CANCEL, regionSel: SEL_MODAL_REGION },
  );
  if (!clicked) throw new Error('Dry-run modal dismiss control not found');
}

async function confirmRemoval(
  page: Page, log: LogFn, logLevel: LogLevel,
): Promise<void> {
  await log(msg.clicking('confirm removal'));
  await domClick(page, SEL_MODAL_CONFIRM, 'Confirm removal');

  // Optional second acknowledgment modal (MN sometimes shows "Okay" after confirm).
  try {
    await waitForSelector(page, SEL_MODAL_CONFIRM, OPTIONAL_ACK_TIMEOUT_MS);
    await domClick(page, SEL_MODAL_CONFIRM, 'Confirm acknowledgment');
  } catch {
    if (logLevel === 'debug') {
      await log('DIAG confirmRemoval: no second acknowledgment modal appeared');
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function performRemoval(
  page: Page, log: LogFn, memberId: string, dryRun: boolean, logLevel: LogLevel,
): Promise<void> {
  await openMemberMenu(page, memberId, log, logLevel);
  await expandMoreActions(page, log, logLevel);
  await clickRemoveFromSpace(page, log, logLevel);

  if (dryRun) {
    await dismissDryRunModal(page, log);
    return;
  }

  await confirmRemoval(page, log, logLevel);
}

async function settleAfterDryRunInteraction(
  page: Page, log: LogFn, logLevel: LogLevel, sleep: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    await waitForSelectorAbsent(page, SEL_MODAL_REGION, DRY_RUN_SETTLE_WAIT_MS);
  } catch {
    await sleep(DRY_RUN_SETTLE_FALLBACK_SLEEP_MS);
    if (logLevel === 'debug') {
      await log(`DIAG dryRun: settle timed out; slept ${DRY_RUN_SETTLE_FALLBACK_SLEEP_MS}ms`);
    }
  }
}

async function scrollFlyout(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const flyout = document.querySelector(sel);
    if (!flyout) return;
    flyout.scrollTop = flyout.scrollHeight;
  }, SEL_FLYOUT);
}

async function countMemberRows(page: Page): Promise<number> {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, SEL_MEMBER_ROW);
}

/**
 * Scroll the flyout repeatedly until no new member rows appear for
 * SCROLL_MAX_RETRIES consecutive attempts. Returns total row count.
 */
async function scrollUntilStable(
  page: Page, sleep: (ms: number) => Promise<void>,
): Promise<number> {
  let previousCount = await countMemberRows(page);
  let stableAttempts = 0;
  while (stableAttempts < SCROLL_MAX_RETRIES) {
    await scrollFlyout(page);
    await sleep(SCROLL_LOAD_MS);
    const current = await countMemberRows(page);
    if (current > previousCount) {
      previousCount = current;
      stableAttempts = 0;
    } else {
      stableAttempts++;
    }
  }
  return previousCount;
}

async function pickFirstEligibleRow(
  page: Page, processedIds: Set<string>,
): Promise<{ row: ElementHandle<Element>; meta: RowMeta } | null> {
  const rows = await page.$$(SEL_MEMBER_ROW);
  for (const row of rows) {
    const meta = await readRowMeta(row);
    if (ADMIN_IDS.includes(meta.memberId)) continue;
    if (processedIds.has(meta.memberId)) continue;
    return { row, meta };
  }
  return null;
}

async function logAbortAndReturn(
  log: LogFn, removed: number,
): Promise<RemoveSpaceMembersResult> {
  await log(msg.abortAfterRemovals(removed));
  return { success: true, removed, error: abortedRemovalMessage(removed) };
}

async function logErrorAndFail(
  log: LogFn, removed: number, error: string,
): Promise<RemoveSpaceMembersResult> {
  await log(error);
  return { success: false, removed, error };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function removeSpaceMembers({
  page, fullSpaceName, dryRun = true, log, abortSignal,
  sleep: sleepArg, logLevel = DEFAULT_LOG_LEVEL,
}: RemoveSpaceMembersArgs): Promise<RemoveSpaceMembersResult> {
  const sleep = sleepArg ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const spaceId = SPACE_IDS[fullSpaceName];
  if (!spaceId || !fullSpaceName.trim()) {
    return { success: false, removed: 0, error: msg.unknownSpace(fullSpaceName) };
  }

  const url = `https://emergent-commons.mn.co/spaces/${spaceId}/admin/members/all`;
  let removed = 0;
  const processedIds = new Set<string>();

  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    await loginIfNeeded(page, log);
    await page.waitForSelector(SEL_READY, { timeout: 60_000 });
    await page.waitForSelector(SEL_FLYOUT, { timeout: 60_000 });
    await page.waitForSelector(`${SEL_FLYOUT} ${SEL_TABLE_MEMBERS}`, { timeout: 60_000 });

    const totalLoaded = await scrollUntilStable(page, sleep);
    await log(msg.memberListLoaded(fullSpaceName, totalLoaded));
    if (dryRun) await log(msg.dryRunNoRemovals());

    while (true) {
      if (abortSignal.aborted) return logAbortAndReturn(log, removed);

      const picked = await pickFirstEligibleRow(page, processedIds);
      if (!picked) break;

      const { row, meta } = picked;
      const { name, memberId } = meta;

      if (abortSignal.aborted) return logAbortAndReturn(log, removed);

      processedIds.add(memberId);

      try {
        await log(dryRun ? msg.dryRunWouldRemove(name, memberId) : msg.removingMember(name, memberId));
        await performRemoval(page, log, memberId, dryRun, logLevel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return logErrorAndFail(log, removed, message);
      } finally {
        await row.dispose().catch(() => undefined);
      }

      if (dryRun) {
        await settleAfterDryRunInteraction(page, log, logLevel, sleep);
        continue;
      }

      try {
        await page.waitForFunction(
          (id) => document.querySelector(`[data-member-item="${id}"]`) === null,
          { timeout: WAIT_ROW_UPDATE_MS },
          memberId,
        );
      } catch {
        return logErrorAndFail(log, removed, msg.removalNotConfirmed(name, memberId));
      }

      removed += 1;
      await log(msg.removalComplete(removed, name));
    }

    return { success: true, removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return logErrorAndFail(log, removed, message);
  }
}
