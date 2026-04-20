import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getLaunchOptions,
  maybeResetProfileForAccountSwitch,
  writeProfileAccount,
} from '../src/utils/browser.js';

describe('getLaunchOptions', () => {
  const oldDir = process.env.PUPPETEER_USER_DATA_DIR;

  afterEach(() => {
    if (typeof oldDir === 'string') {
      process.env.PUPPETEER_USER_DATA_DIR = oldDir;
    } else {
      delete process.env.PUPPETEER_USER_DATA_DIR;
    }
  });

  it('uses new headless mode when headless is true', () => {
    delete process.env.PUPPETEER_USER_DATA_DIR;
    const opts = getLaunchOptions(true);
    expect(opts.headless).toBe('new');
    expect(opts.args).toEqual(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      : []);
  });

  it('disables headless when headless is false', () => {
    delete process.env.PUPPETEER_USER_DATA_DIR;
    const opts = getLaunchOptions(false);
    expect(opts.headless).toBe(false);
  });

  it('includes userDataDir when configured', () => {
    process.env.PUPPETEER_USER_DATA_DIR = '.puppeteer-profile';
    const opts = getLaunchOptions(true);
    expect(opts.headless).toBe('new');
    expect(opts.userDataDir).toBe('.puppeteer-profile');
  });
});

describe('writeProfileAccount / maybeResetProfileForAccountSwitch', () => {
  let tmpRoot: string;
  let profileDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'puppeteer-profile-test-'));
    profileDir = path.join(tmpRoot, '.puppeteer-profile');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('writeProfileAccount creates the marker inside the profile dir', async () => {
    await writeProfileAccount(profileDir, 'old@example.com');
    const marker = await fs.readFile(path.join(profileDir, '.account'), 'utf8');
    expect(marker).toBe('old@example.com');
  });

  it('does not reset when the marker matches the current MN_EMAIL', async () => {
    await writeProfileAccount(profileDir, 'same@example.com');
    await fs.writeFile(path.join(profileDir, 'Cookies'), 'session-data', 'utf8');

    const reset = await maybeResetProfileForAccountSwitch(
      profileDir,
      'same@example.com',
    );

    expect(reset).toBe(false);
    const cookies = await fs.readFile(path.join(profileDir, 'Cookies'), 'utf8');
    expect(cookies).toBe('session-data');
  });

  it('resets (deletes) the profile dir when the marker disagrees with MN_EMAIL', async () => {
    await writeProfileAccount(profileDir, 'old@example.com');
    await fs.writeFile(path.join(profileDir, 'Cookies'), 'old-session', 'utf8');

    const logs: string[] = [];
    const reset = await maybeResetProfileForAccountSwitch(
      profileDir,
      'new@example.com',
      (msg) => logs.push(msg),
    );

    expect(reset).toBe(true);
    await expect(fs.access(profileDir)).rejects.toThrow();
    expect(logs.some((m) => m.includes('old@example.com') && m.includes('new@example.com'))).toBe(true);
  });

  it('does not reset when no marker file exists (first-run case)', async () => {
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(path.join(profileDir, 'Cookies'), 'fresh-session', 'utf8');

    const reset = await maybeResetProfileForAccountSwitch(
      profileDir,
      'any@example.com',
    );

    expect(reset).toBe(false);
    const cookies = await fs.readFile(path.join(profileDir, 'Cookies'), 'utf8');
    expect(cookies).toBe('fresh-session');
  });

  it('is a no-op when MN_EMAIL is missing', async () => {
    await writeProfileAccount(profileDir, 'old@example.com');
    const reset = await maybeResetProfileForAccountSwitch(profileDir, undefined);
    expect(reset).toBe(false);
    const marker = await fs.readFile(path.join(profileDir, '.account'), 'utf8');
    expect(marker).toBe('old@example.com');
  });

  it('tolerates a missing profile dir entirely', async () => {
    const reset = await maybeResetProfileForAccountSwitch(
      path.join(tmpRoot, 'never-existed'),
      'someone@example.com',
    );
    expect(reset).toBe(false);
  });
});
