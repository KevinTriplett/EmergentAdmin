import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ElementHandle, Page } from 'puppeteer';
import { removeSpaceMembers } from '../src/tasks/removeSpaceMembers.js';
import { loginIfNeeded } from '../src/auth.js';

vi.mock('../src/auth.js', () => ({
  loginIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

function mockClickableHandle(): ElementHandle<Element> {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as ElementHandle<Element>;
}

function mockRow(memberId: string, name: string, href: string): ElementHandle<Element> {
  const actionHandle = mockClickableHandle();
  return {
    dispose: vi.fn().mockResolvedValue(undefined),
    $: vi.fn().mockResolvedValue(actionHandle),
    evaluate: vi.fn(async (fn: (el: Element) => unknown) => {
      const el = {
        getAttribute: (k: string) => (k === 'data-member-item' ? memberId : null),
        querySelector: (sel: string) => {
          if (sel.includes('a')) {
            return {
              getAttribute: (k: string) => (k === 'title' ? name : null),
              textContent: name,
              href,
            };
          }
          return null;
        },
      } as unknown as Element;
      return fn(el);
    }),
  } as unknown as ElementHandle<Element>;
}

describe('removeSpaceMembers', () => {
  const log = vi.fn<(m: string) => void | Promise<void>>().mockResolvedValue(undefined);

  beforeEach(() => {
    log.mockClear();
    vi.mocked(loginIfNeeded).mockClear();
  });

  it('returns unknown space when name is not in the map', async () => {
    const page = {} as unknown as Page;

    const result = await removeSpaceMembers({
      page,
      fullSpaceName: 'Not A Real Space',
      dryRun: true,
      log,
      abortSignal: { aborted: false },
    });

    expect(result).toEqual({
      success: false,
      removed: 0,
      error: 'Unknown space: "Not A Real Space".',
    });
    expect(loginIfNeeded).not.toHaveBeenCalled();
  });

  it('rejects empty fullSpaceName like unknown space', async () => {
    const page = {} as unknown as Page;
    const result = await removeSpaceMembers({
      page,
      fullSpaceName: '',
      dryRun: true,
      log,
      abortSignal: { aborted: false },
    });
    expect(result.success).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.error).toContain('Unknown space');
  });

  it('dry run visits URL, logs, and completes with removed 0 when one member then exhausted', async () => {
    const goto = vi.fn().mockResolvedValue(undefined);
    const waitForSelector = vi.fn().mockResolvedValue(undefined);
    const waitForFunction = vi.fn().mockResolvedValue(undefined);
    const memberRow = mockRow('111', 'Member One', 'https://emergent-commons.mn.co/u/1');
    const $$ = vi
      .fn()
      .mockResolvedValueOnce([memberRow])
      .mockResolvedValueOnce([memberRow])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    const $ = vi.fn(async (selector: string) => {
      if (selector.includes('[data-member-item="111"]')) return memberRow;
      return mockClickableHandle();
    });
    const evaluate = vi.fn().mockResolvedValue(true);

    const page = { goto, waitForSelector, waitForFunction, $$, $, evaluate } as unknown as Page;

    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await removeSpaceMembers({
      page,
      fullSpaceName: 'Marketplace',
      dryRun: true,
      log,
      abortSignal: { aborted: false },
      sleep,
    });

    expect(goto).toHaveBeenCalledWith(
      'https://emergent-commons.mn.co/spaces/5627234/admin/members/all',
      expect.objectContaining({ waitUntil: 'networkidle2' }),
    );
    expect(loginIfNeeded).toHaveBeenCalledWith(page, log);
    expect(result).toEqual({ success: true, removed: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/dry run: would remove/i));
    expect(log).toHaveBeenCalledWith(
      'Dry run: no members will actually be removed.',
    );
  });

  it('returns abort result with harmonized message after logging would-remove', async () => {
    const goto = vi.fn().mockResolvedValue(undefined);
    const waitForSelector = vi.fn().mockResolvedValue(undefined);
    const memberRow = mockRow('222', 'Member Two', 'https://emergent-commons.mn.co/u/2');
    const $$ = vi.fn().mockResolvedValue([memberRow]);
    const $ = vi.fn().mockResolvedValue({
      evaluate: vi.fn().mockResolvedValue(undefined),
    });
    const page = { goto, waitForSelector, $$, $ } as unknown as Page;

    const result = await removeSpaceMembers({
      page,
      fullSpaceName: 'Creative Center',
      dryRun: true,
      log,
      abortSignal: { aborted: true },
    });

    expect(result).toEqual({
      success: true,
      removed: 0,
      error: 'Aborted by user after 0 removals',
    });
    expect(log).toHaveBeenCalledWith('Abort requested; stopping after 0 removals.');
  });
});
