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
const SEL_MODAL_REGION = '#modal-content-region';

// === SPACE IDS — Maps display name to MN space ID ===
const SPACE_IDS: Record<string, string> = {
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

const SCROLL_LOAD_MS = 2000;
const WAIT_SHORT_MS = 15_000;
const WAIT_ROW_UPDATE_MS = 30_000;
const OPTIONAL_ACK_TIMEOUT_MS = 1200;

export type LogLevel = 'light' | 'debug';
const DEFAULT_LOG_LEVEL: LogLevel =
  process.env.REMOVE_MEMBERS_LOG_LEVEL === 'debug' ? 'debug' : 'light';

/** Normalize visible UI text for comparisons (whitespace, MN quirks). */
function normalizeUiText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Shared phrasing: member display name + id — keeps log grammar consistent. */
function memberRef(name: string, memberId: string): string {
  return `${name} (member ${memberId})`;
}

function pluralSuffix(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/** User-facing log lines — single source of truth for wording and grammar. */
const msg = {
  unknownSpace: (name: string) => `Unknown space: "${name}".`,
  memberListLoaded: (space: string) => `Member list loaded for "${space}".`,
  dryRunNoRemovals: () => 'Dry run: no members will actually be removed.',
  abortAfterRemovals: (n: number) =>
    `Abort requested; stopping after ${n} removal${pluralSuffix(n, '', 's')}.`,
  dryRunWouldRemove: (name: string, memberId: string) =>
    `Dry run: would remove ${memberRef(name, memberId)}.`,
  removingMember: (name: string, memberId: string) =>
    `Removing ${memberRef(name, memberId)}.`,
  removalComplete: (ordinal: number, name: string) =>
    `Removal ${ordinal} complete: ${name}.`,
  staleGuard: (name: string, memberId: string) =>
    `STALE GUARD: ${memberRef(name, memberId)} is still first in the list after removal. Halting.`,
  timeoutRowUpdate: () => 'Timed out waiting for the member list to update after removal.',
  clicking: (label: string) => `Clicking ${label}…`,
  clickFallback: (label: string, detail: string) =>
    `${label}: standard click failed; using DOM click instead. ${detail}`,
} as const;

const clickTarget = {
  memberMenu: 'member action menu',
  moreActions: 'more actions control',
  removeFromSpace: 'Remove from space',
  confirmRemoval: 'confirm removal',
} as const;

/** Puppeteer step key → stable “not found” copy (capitalized product wording). */
const STEP_NOT_FOUND: Record<keyof typeof clickTarget, string> = {
  memberMenu: 'Member action dropdown not found',
  moreActions: 'More actions control not found',
  removeFromSpace: 'Remove from space control not found',
  confirmRemoval: 'Confirm removal control not found',
};

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

async function readRowMeta(row: ElementHandle<Element>): Promise<RowMeta> {
  return row.evaluate((el) => {
    const memberId = el.getAttribute('data-member-item') ?? '';
    const link = (el.querySelector('a.navigate[href]') as HTMLAnchorElement) || null;
    const name = link?.getAttribute('title')?.trim() || link?.textContent?.trim() || '';
    return { memberId, name };
  });
}

async function waitForSelectorInDom(
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

type SelectorDiagnostics = {
  selector: string;
  count: number;
  firstVisible: boolean;
  firstRect: { x: number; y: number; width: number; height: number } | null;
  firstPointerEvents: string | null;
  firstDisplay: string | null;
  firstVisibility: string | null;
  centerHitMatchesFirst: boolean | null;
};

async function gatherSelectorDiagnostics(
  page: Page,
  selector: string,
): Promise<SelectorDiagnostics> {
  return page.evaluate((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    const first = (nodes[0] as HTMLElement | undefined) ?? null;
    if (!first) {
      return {
        selector: sel,
        count: 0,
        firstVisible: false,
        firstRect: null,
        firstPointerEvents: null,
        firstDisplay: null,
        firstVisibility: null,
        centerHitMatchesFirst: null,
      };
    }

    const rect = first.getBoundingClientRect();
    const style = window.getComputedStyle(first);
    const firstVisible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    const centerHitMatchesFirst = hit === first || (hit ? first.contains(hit) : false);

    return {
      selector: sel,
      count: nodes.length,
      firstVisible,
      firstRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      firstPointerEvents: style.pointerEvents,
      firstDisplay: style.display,
      firstVisibility: style.visibility,
      centerHitMatchesFirst,
    };
  }, selector);
}

async function armClickDiagnostics(handle: ElementHandle<Element>): Promise<void> {
  await handle.evaluate((el) => {
    const n = el as HTMLElement & { __diagClicks?: number; __diagMouseDown?: number };
    n.__diagClicks = 0;
    n.__diagMouseDown = 0;
    n.addEventListener(
      'mousedown',
      () => {
        n.__diagMouseDown = (n.__diagMouseDown || 0) + 1;
      },
      { capture: true },
    );
    n.addEventListener(
      'click',
      () => {
        n.__diagClicks = (n.__diagClicks || 0) + 1;
      },
      { capture: true },
    );
  });
}

async function readClickDiagnostics(
  handle: ElementHandle<Element>,
): Promise<{ clickCount: number; mouseDownCount: number }> {
  return handle.evaluate((el) => {
    const n = el as HTMLElement & { __diagClicks?: number; __diagMouseDown?: number };
    return { clickCount: n.__diagClicks || 0, mouseDownCount: n.__diagMouseDown || 0 };
  });
}

async function logSelectorDiagnostics(page: Page, selector: string, log: LogFn, stage: string): Promise<void> {
  const d = await gatherSelectorDiagnostics(page, selector);
  await log(
    `DIAG ${stage}: selector="${d.selector}" count=${d.count} visible=${d.firstVisible} rect=${JSON.stringify(
      d.firstRect,
    )} pointerEvents=${d.firstPointerEvents} display=${d.firstDisplay} visibility=${d.firstVisibility} centerHitMatchesFirst=${d.centerHitMatchesFirst}`,
  );
}

async function isSelectorVisible(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, selector);
}

async function clickHandleSafely(
  handle: ElementHandle<Element>,
  stepLabel: string,
  log: LogFn,
): Promise<void> {
  await log(msg.clicking(stepLabel));

  await handle.evaluate((el) => {
    (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  });

  try {
    await handle.click({ delay: 25 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await log(msg.clickFallback(stepLabel, detail));
    throw err;
  }
}

async function disposeHandle(handle: ElementHandle<Element> | null): Promise<void> {
  if (!handle) return;
  if (typeof handle.dispose === 'function') {
    await handle.dispose().catch(() => undefined);
  }
}

async function clickRowScopedControl(
  row: ElementHandle<Element>,
  selector: string,
  stepKey: keyof typeof clickTarget,
  log: LogFn,
): Promise<void> {
  const handle = await row.$(selector);
  if (!handle) throw new Error(STEP_NOT_FOUND[stepKey]);
  try {
    await clickHandleSafely(handle, clickTarget[stepKey], log);
  } finally {
    await disposeHandle(handle);
  }
}

async function waitDomThenClickPageControl(
  page: Page,
  selector: string,
  stepKey: keyof typeof clickTarget,
  log: LogFn,
  timeoutMs: number,
  logLevel: LogLevel,
): Promise<void> {
  if (stepKey === 'moreActions' && logLevel === 'debug') {
    await logSelectorDiagnostics(page, selector, log, 'before-wait');
  }
  await waitForSelectorInDom(page, selector, timeoutMs);
  if (stepKey === 'moreActions' && logLevel === 'debug') {
    await logSelectorDiagnostics(page, selector, log, 'after-wait');
  }
  const handle = await page.$(selector);
  if (!handle) throw new Error(STEP_NOT_FOUND[stepKey]);
  try {
    if (stepKey === 'moreActions' && logLevel === 'debug') {
      await armClickDiagnostics(handle);
    }
    try {
      await clickHandleSafely(handle, clickTarget[stepKey], log);
    } catch {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Selector not found for DOM click fallback: ${sel}`);
        (el as HTMLElement).click();
      }, selector);
      if (logLevel === 'debug') {
        await log(`DIAG ${String(stepKey)}: used selector-based DOM click fallback`);
      }
    }
    if (stepKey === 'moreActions' && logLevel === 'debug') {
      const clickDiag = await readClickDiagnostics(handle);
      await log(
        `DIAG moreActions: target events mousedown=${clickDiag.mouseDownCount} click=${clickDiag.clickCount}`,
      );
      await logSelectorDiagnostics(page, selector, log, 'after-click');
      let removeVisible = await isSelectorVisible(page, SEL_REMOVE_FROM_SPACE);
      await log(`DIAG moreActions: remove-control-visible-after-click=${removeVisible}`);
      if (!removeVisible) {
        await log('DIAG moreActions: forcing DOM click fallback because submenu did not expand');
        await handle.evaluate((el) => {
          (el as HTMLElement).click();
        });
        removeVisible = await isSelectorVisible(page, SEL_REMOVE_FROM_SPACE);
        await log(`DIAG moreActions: remove-control-visible-after-dom-click=${removeVisible}`);
        if (!removeVisible) {
          await logSelectorDiagnostics(page, selector, log, 'after-dom-click');
        }
      }
    }
  } finally {
    await disposeHandle(handle);
  }
}

async function clickPageControlIfAppears(
  page: Page,
  selector: string,
  stepKey: keyof typeof clickTarget,
  log: LogFn,
  timeoutMs: number,
  logLevel: LogLevel,
): Promise<boolean> {
  try {
    await waitDomThenClickPageControl(page, selector, stepKey, log, timeoutMs, logLevel);
    return true;
  } catch (err) {
    if (logLevel === 'debug') {
      const message = err instanceof Error ? err.message : String(err);
      await log(`DIAG optional ${String(stepKey)} click skipped: ${message}`);
    }
    return false;
  }
}

async function ensureMemberMenuOpened(
  page: Page,
  row: ElementHandle<Element>,
  log: LogFn,
  logLevel: LogLevel,
): Promise<void> {
  const tryOpen = async (): Promise<boolean> => {
    const handle = await row.$(SEL_MEMBER_DROPDOWN);
    if (!handle) throw new Error(STEP_NOT_FOUND.memberMenu);
    try {
      try {
        await clickHandleSafely(handle, clickTarget.memberMenu, log);
      } catch {
        await handle.evaluate((el) => {
          (el as HTMLElement).click();
        });
        if (logLevel === 'debug') {
          await log('DIAG memberMenu: used row-scoped DOM click fallback');
        }
      }
    } finally {
      await disposeHandle(handle);
    }
    return isSelectorVisible(page, SEL_MEMBER_DROPDOWN_MORE);
  };

  if (await tryOpen()) return;
  if (logLevel === 'debug') {
    await log('DIAG memberMenu: more control missing after first click; retrying member menu click');
  }
  if (await tryOpen()) return;
  throw new Error('Member action menu opened but More actions control did not appear');
}

async function performRemoval(
  page: Page,
  row: ElementHandle<Element>,
  log: LogFn,
  logLevel: LogLevel,
): Promise<void> {
  await ensureMemberMenuOpened(page, row, log, logLevel);

  await waitDomThenClickPageControl(
    page,
    SEL_MEMBER_DROPDOWN_MORE,
    'moreActions',
    log,
    WAIT_SHORT_MS,
    logLevel,
  );

  await waitDomThenClickPageControl(
    page,
    SEL_REMOVE_FROM_SPACE,
    'removeFromSpace',
    log,
    WAIT_SHORT_MS,
    logLevel,
  );

  await waitDomThenClickPageControl(
    page,
    SEL_MODAL_CONFIRM,
    'confirmRemoval',
    log,
    WAIT_SHORT_MS,
    logLevel,
  );
  await clickPageControlIfAppears(
    page,
    SEL_MODAL_CONFIRM,
    'confirmRemoval',
    log,
    OPTIONAL_ACK_TIMEOUT_MS,
    logLevel,
  );
}

async function scrollFlyout(page: Page): Promise<void> {
  const flyout = await page.$(SEL_FLYOUT);
  if (!flyout) return;
  try {
    await flyout.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  } finally {
    await disposeHandle(flyout);
  }
}

async function pickFirstEligibleRow(
  page: Page,
  dryRun: boolean,
  dryRunSeen: Set<string>,
): Promise<{ row: ElementHandle<Element>; meta: RowMeta } | null> {
  const rows = await page.$$(SEL_MEMBER_ROW);
  for (const row of rows) {
    const meta = await readRowMeta(row);
    if (ADMIN_IDS.includes(meta.memberId)) continue;
    if (dryRun && dryRunSeen.has(meta.memberId)) continue;
    return { row, meta };
  }
  return null;
}

async function logAbortAndReturn(
  log: LogFn,
  removed: number,
): Promise<RemoveSpaceMembersResult> {
  await log(msg.abortAfterRemovals(removed));
  return {
    success: true,
    removed,
    error: abortedRemovalMessage(removed),
  };
}

async function logErrorAndFail(
  log: LogFn,
  removed: number,
  error: string,
): Promise<RemoveSpaceMembersResult> {
  await log(error);
  return { success: false, removed, error };
}

export async function removeSpaceMembers({
  page,
  fullSpaceName,
  dryRun = true,
  log,
  abortSignal,
  sleep: sleepArg,
  logLevel = DEFAULT_LOG_LEVEL,
}: RemoveSpaceMembersArgs): Promise<RemoveSpaceMembersResult> {
  const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const sleep = sleepArg ?? defaultSleep;

  const spaceId = SPACE_IDS[fullSpaceName];
  if (!spaceId || !fullSpaceName.trim()) {
    return {
      success: false,
      removed: 0,
      error: msg.unknownSpace(fullSpaceName),
    };
  }

  const url = `https://emergent-commons.mn.co/spaces/${spaceId}/admin/members/all`;

  let removed = 0;
  const dryRunSeen = new Set<string>();

  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    await loginIfNeeded(page, log);
    await page.waitForSelector(SEL_READY, { timeout: 60_000 });
    await page.waitForSelector(SEL_FLYOUT, { timeout: 60_000 });
    await page.waitForSelector(`${SEL_FLYOUT} ${SEL_TABLE_MEMBERS}`, { timeout: 60_000 });
    await log(msg.memberListLoaded(fullSpaceName));
    if (dryRun) {
      await log(msg.dryRunNoRemovals());
    }

    while (true) {
      if (abortSignal.aborted) {
        return logAbortAndReturn(log, removed);
      }

      let picked = await pickFirstEligibleRow(page, dryRun, dryRunSeen);

      if (!picked) {
        await scrollFlyout(page);
        await sleep(SCROLL_LOAD_MS);
        picked = await pickFirstEligibleRow(page, dryRun, dryRunSeen);
        if (!picked) {
          break;
        }
      }

      const { row, meta } = picked;
      const { name, memberId } = meta;

      if (abortSignal.aborted) {
        return logAbortAndReturn(log, removed);
      }

      if (dryRun) {
        await log(msg.dryRunWouldRemove(name, memberId));
        dryRunSeen.add(memberId);
        await row.dispose().catch(() => undefined);
        continue;
      }

      try {
        await log(msg.removingMember(name, memberId));
        await performRemoval(page, row, log, logLevel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return logErrorAndFail(log, removed, message);
      } finally {
        await row.dispose().catch(() => undefined);
      }

      try {
        await page.waitForFunction(
          ({ memberId: id, adminList }) => {
            const rows = Array.from(document.querySelectorAll('[data-member-item]'));
            for (const el of rows) {
              const mid = el.getAttribute('data-member-item') ?? '';
              if (adminList.includes(mid)) continue;
              if (mid !== id) return true;
              return false;
            }
            return true;
          },
          { timeout: WAIT_ROW_UPDATE_MS },
          { memberId, adminList: ADMIN_IDS },
        );
      } catch {
        return logErrorAndFail(log, removed, msg.timeoutRowUpdate());
      }

      const nextRows = await page.$$(SEL_MEMBER_ROW);
      let nextFirst: RowMeta | null = null;
      for (const r of nextRows) {
        const m = await readRowMeta(r);
        if (ADMIN_IDS.includes(m.memberId)) continue;
        nextFirst = m;
        break;
      }

      if (!nextFirst) {
        await scrollFlyout(page);
        await sleep(SCROLL_LOAD_MS);
        const again = await pickFirstEligibleRow(page, dryRun, dryRunSeen);
        if (!again) {
          removed += 1;
          await log(msg.removalComplete(removed, name));
          break;
        }
        removed += 1;
        await log(msg.removalComplete(removed, name));
        continue;
      }

      if (nextFirst.memberId === memberId) {
        return logErrorAndFail(log, removed, msg.staleGuard(name, memberId));
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
