import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ElementHandle, Page } from 'puppeteer';
import { addSpaceMember } from '../src/tasks/addSpaceMember.js';
import { loginIfNeeded } from '../src/auth.js';

vi.mock('../src/auth.js', () => ({
  loginIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

function mockHandle(): ElementHandle<Element> {
  return {
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as ElementHandle<Element>;
}

/**
 * Build a Puppeteer `Page` mock loose enough for the happy path: every DOM
 * click (`evaluate`) succeeds, every wait resolves, and `$` returns null by
 * default. Tests override specific methods to exercise specific branches.
 */
function buildPage(overrides: Partial<Page> = {}): Page {
  const base = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(true),
    $: vi.fn().mockResolvedValue(null),
    focus: vi.fn().mockResolvedValue(undefined),
    keyboard: { type: vi.fn().mockResolvedValue(undefined) },
  };
  return { ...base, ...overrides } as unknown as Page;
}

describe('addSpaceMember', () => {
  const log = vi.fn<(m: string) => void | Promise<void>>().mockResolvedValue(undefined);

  beforeEach(() => {
    log.mockClear();
    vi.mocked(loginIfNeeded).mockClear();
  });

  it('returns unknown space when name is not in the map', async () => {
    const page = {} as unknown as Page;

    const result = await addSpaceMember({
      page,
      fullMemberName: 'Jane Doe',
      memberId: '12345',
      fullSpaceName: 'Not A Real Space',
      log,
      abortSignal: { aborted: false },
    });

    expect(result).toEqual({
      success: false,
      error: 'Unknown space: "Not A Real Space".',
    });
    expect(loginIfNeeded).not.toHaveBeenCalled();
  });

  it('rejects empty fullSpaceName like unknown space', async () => {
    const page = {} as unknown as Page;
    const result = await addSpaceMember({
      page,
      fullMemberName: 'Jane Doe',
      memberId: '12345',
      fullSpaceName: '',
      log,
      abortSignal: { aborted: false },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown space/i);
  });

  it('rejects empty fullMemberName with a validation error', async () => {
    const page = {} as unknown as Page;
    const result = await addSpaceMember({
      page,
      fullMemberName: '   ',
      memberId: '12345',
      fullSpaceName: 'Marketplace',
      log,
      abortSignal: { aborted: false },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/fullMemberName/);
    expect(loginIfNeeded).not.toHaveBeenCalled();
  });

  it('rejects empty memberId with a validation error', async () => {
    const page = {} as unknown as Page;
    const result = await addSpaceMember({
      page,
      fullMemberName: 'Jane Doe',
      memberId: '',
      fullSpaceName: 'Marketplace',
      log,
      abortSignal: { aborted: false },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/memberId/);
  });

  it('short-circuits with abort result when aborted before any browser work', async () => {
    const page = buildPage();
    const result = await addSpaceMember({
      page,
      fullMemberName: 'Jane Doe',
      memberId: '12345',
      fullSpaceName: 'Marketplace',
      log,
      abortSignal: { aborted: true },
    });

    expect(result).toEqual({ success: true, error: 'Aborted by user' });
    expect(loginIfNeeded).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('returns "Already a member" when the row is present after search on the space page', async () => {
    const page = buildPage({
      $: vi.fn(async (selector: string) => {
        // The only `$` probe in the task is the already-a-member row check.
        if (selector.includes("data-member-item='12345'")) return mockHandle();
        return null;
      }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await addSpaceMember({
      page,
      fullMemberName: 'Jane Doe',
      memberId: '12345',
      fullSpaceName: 'Marketplace',
      log,
      abortSignal: { aborted: false },
      sleep,
    });

    expect(result).toEqual({ success: true, error: 'Already a member' });
    expect(page.goto).toHaveBeenCalledWith(
      'https://emergent-commons.mn.co/spaces/5627234/admin/members/all',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(page.goto).toHaveBeenCalledTimes(1); // never navigates to the global members page
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/already in "Marketplace"/i));
  });

  it('completes the happy path across the space page and the global members page', async () => {
    const page = buildPage();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await addSpaceMember({
      page,
      fullMemberName: 'Jane Doe',
      memberId: '12345',
      fullSpaceName: 'Marketplace',
      log,
      abortSignal: { aborted: false },
      sleep,
    });

    expect(result).toEqual({ success: true });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenNthCalledWith(
      1,
      'https://emergent-commons.mn.co/spaces/5627234/admin/members/all',
      expect.any(Object),
    );
    expect(page.goto).toHaveBeenNthCalledWith(
      2,
      'https://emergent-commons.mn.co/admin/members/all',
      expect.any(Object),
    );
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/added "Jane Doe" to "Marketplace"/i));
  });

  it('returns failure when the success toast never appears', async () => {
    // Reject only the toast wait (identified by the toast selector), resolve everything else.
    const waitForFunction = vi.fn(async (_fn: unknown, _opts: unknown, ...args: unknown[]) => {
      const selector = args.find((a) => typeof a === 'string') as string | undefined;
      if (selector && selector.includes('notifyjs-corner')) {
        throw new Error('timeout waiting for toast');
      }
      return undefined;
    });
    const page = buildPage({ waitForFunction });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await addSpaceMember({
      page,
      fullMemberName: 'Jane Doe',
      memberId: '12345',
      fullSpaceName: 'Marketplace',
      log,
      abortSignal: { aborted: false },
      sleep,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/toast|will be added/i);
  });
});
