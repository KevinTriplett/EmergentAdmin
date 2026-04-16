import { describe, it, expect, afterEach } from 'vitest';
import { getLaunchOptions } from '../src/utils/browser.js';

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
