import type { ElementHandle, Page } from 'puppeteer';
import { loginIfNeeded, type LogFn } from '../auth.js';
import { abortedRemovalMessage } from '../abortRemoval.js';

// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_FLYOUT = '#flyout-main-content';
const SEL_TABLE_MEMBERS = '.all-members-list-items';
const SEL_MEMBER_ROW = 'tr[data-member-item]';
const SEL_MEMBER_DROPDOWN = '.actions-region a.mighty-drop-down-toggle';
const SEL_MEMBER_DROPDOWN_MORE =
  '.actions-region .mighty-drop-down-menu-region .menu-list-item-more-host-FlexSpace-actions .toggle-child-expanded-button';

// === TEXT LABELS — UPDATE THESE IF MN CHANGES ITS UI TEXT ===
const TXT_REMOVE_MEMBER = 'Remove from Space';
const TXT_REMOVE_CONFIRM = 'Remove This Member';
const TXT_REMOVE_OKAY = 'Okay';

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
const ADMIN_IDS = ['7698608'];

const SCROLL_LOAD_MS = 2000;

export type RemoveSpaceMembersArgs = {
  page: Page;
  fullSpaceName: string;
  dryRun?: boolean;
  log: LogFn;
  abortSignal: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
};

export type RemoveSpaceMembersResult = {
  success: boolean;
  removed: number;
  error?: string;
};

type RowMeta = { memberId: string; name: string; profileUrl: string };

async function readRowMeta(row: ElementHandle<Element>): Promise<RowMeta> {
  return row.evaluate((el) => {
    const memberId = el.getAttribute('data-member-item') ?? '';
    const link = el.querySelector('td a[href]') as HTMLAnchorElement | null;
    const name = link?.getAttribute('title')?.trim() || link?.textContent?.trim() || '';
    const profileUrl = link?.href || '';
    return { memberId, name, profileUrl };
  });
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
    throw new Error(`Could not find element with exact text: ${text}`);
  }
}

async function performRemoval(page: Page, row: ElementHandle<Element>): Promise<void> {
  const dropdown = await row.$(SEL_MEMBER_DROPDOWN);
  if (!dropdown) throw new Error('Member action dropdown not found');
  await dropdown.click();
  await dropdown.dispose();

  await page.waitForFunction(
    (sel) => document.querySelector(sel) !== null,
    { timeout: 15_000 },
    SEL_MEMBER_DROPDOWN_MORE,
  );

  const more = await row.$(SEL_MEMBER_DROPDOWN_MORE);
  if (!more) throw new Error('More actions toggle not found');
  await more.click();
  await more.dispose();

  await page.waitForFunction(
    (t) =>
      Array.from(document.querySelectorAll('*')).some((e) => e.textContent?.trim() === t),
    { timeout: 15_000 },
    TXT_REMOVE_MEMBER,
  );
  await clickFirstWithExactText(page, TXT_REMOVE_MEMBER);

  await page.waitForFunction(
    (t) =>
      Array.from(document.querySelectorAll('*')).some((e) => e.textContent?.trim() === t),
    { timeout: 15_000 },
    TXT_REMOVE_CONFIRM,
  );
  await clickFirstWithExactText(page, TXT_REMOVE_CONFIRM);

  await page.waitForFunction(
    (t) =>
      Array.from(document.querySelectorAll('*')).some((e) => e.textContent?.trim() === t),
    { timeout: 15_000 },
    TXT_REMOVE_OKAY,
  );
  await clickFirstWithExactText(page, TXT_REMOVE_OKAY);
}

async function scrollFlyout(page: Page): Promise<void> {
  const flyout = await page.$(SEL_FLYOUT);
  if (!flyout) return;
  try {
    await flyout.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  } finally {
    if (typeof flyout.dispose === 'function') {
      await flyout.dispose();
    }
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
    if (dryRun && dryRunSeen.has(meta.profileUrl)) continue;
    return { row, meta };
  }
  return null;
}

export async function removeSpaceMembers({
  page,
  fullSpaceName,
  dryRun = true,
  log,
  abortSignal,
  sleep: sleepArg,
}: RemoveSpaceMembersArgs): Promise<RemoveSpaceMembersResult> {
  const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const sleep = sleepArg ?? defaultSleep;

  const spaceId = SPACE_IDS[fullSpaceName];
  if (!spaceId || !fullSpaceName.trim()) {
    return {
      success: false,
      removed: 0,
      error: `Unknown space: "${fullSpaceName}"`,
    };
  }

  const url = `https://emergent-commons.mn.co/spaces/${spaceId}/admin/members/all`;

  let removed = 0;
  const dryRunSeen = new Set<string>();

  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    await page.waitForSelector(SEL_READY, { timeout: 60_000 });
    await loginIfNeeded(page, log);
    await page.waitForSelector(SEL_FLYOUT, { timeout: 60_000 });
    await page.waitForSelector(`${SEL_FLYOUT} ${SEL_TABLE_MEMBERS}`, { timeout: 60_000 });
    await log(`Loaded member list for: ${fullSpaceName}`);
    if (dryRun) {
      await log('DRY RUN — no members will be removed.');
    }

    while (true) {
      if (abortSignal.aborted) {
        await log(`Abort requested. Stopped after ${removed} removals.`);
        return {
          success: true,
          removed,
          error: abortedRemovalMessage(removed),
        };
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
      const { name, profileUrl } = meta;

      await log(`${dryRun ? 'WOULD REMOVE' : 'Removing'}: ${name} (${profileUrl})`);

      if (abortSignal.aborted) {
        await log(`Abort requested. Stopped after ${removed} removals.`);
        return {
          success: true,
          removed,
          error: abortedRemovalMessage(removed),
        };
      }

      if (dryRun) {
        dryRunSeen.add(profileUrl);
        await row.dispose().catch(() => undefined);
        continue;
      }

      try {
        await performRemoval(page, row);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await log(message);
        return { success: false, removed, error: message };
      } finally {
        await row.dispose().catch(() => undefined);
      }

      try {
        await page.waitForFunction(
          ({ href, adminList }) => {
            const rows = Array.from(document.querySelectorAll('tr[data-member-item]'));
            for (const el of rows) {
              const id = el.getAttribute('data-member-item') ?? '';
              if (adminList.includes(id)) continue;
              const link = el.querySelector('td a[href]') as HTMLAnchorElement | null;
              const h = link?.href ?? '';
              if (h !== href) return true;
              return false;
            }
            return true;
          },
          { timeout: 30_000 },
          { href: profileUrl, adminList: ADMIN_IDS },
        );
      } catch {
        const message = 'Timeout waiting for member row to update after removal';
        await log(message);
        return { success: false, removed, error: message };
      }

      const nextRows = await page.$$(SEL_MEMBER_ROW);
      const nextFirst: RowMeta[] = [];
      for (const r of nextRows) {
        const m = await readRowMeta(r);
        if (ADMIN_IDS.includes(m.memberId)) continue;
        nextFirst.push(m);
        break;
      }

      if (nextFirst.length === 0) {
        await scrollFlyout(page);
        await sleep(SCROLL_LOAD_MS);
        const again = await pickFirstEligibleRow(page, dryRun, dryRunSeen);
        if (!again) {
          removed += 1;
          await log(`Removed ${removed}: ${name}`);
          break;
        }
        removed += 1;
        await log(`Removed ${removed}: ${name}`);
        continue;
      }

      if (nextFirst[0].profileUrl === profileUrl) {
        const msg = `STALE GUARD: ${name} (${profileUrl}) is still at index 0 after confirmed removal. MN may have rejected the removal or re-rendered unexpectedly. Halting.`;
        await log(msg);
        return { success: false, removed, error: msg };
      }

      removed += 1;
      await log(`Removed ${removed}: ${name}`);
    }

    return { success: true, removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(message);
    return { success: false, removed, error: message };
  }
}
