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
    expect(getLaunchOptions(true)).toEqual({ headless: 'new' });
  });

  it('disables headless when headless is false', () => {
    delete process.env.PUPPETEER_USER_DATA_DIR;
    expect(getLaunchOptions(false)).toEqual({ headless: false });
  });

  it('includes userDataDir when configured', () => {
    process.env.PUPPETEER_USER_DATA_DIR = '.puppeteer-profile';
    expect(getLaunchOptions(true)).toEqual({
      headless: 'new',
      userDataDir: '.puppeteer-profile',
    });
  });
});
