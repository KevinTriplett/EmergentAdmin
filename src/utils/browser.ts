import puppeteer from 'puppeteer';
import type { LaunchOptions } from 'puppeteer';

/** MN automation targets Chromium `headless: 'new'`; cast for Puppeteer launch typing drift. */
export function getLaunchOptions(headless: boolean): Pick<LaunchOptions, 'headless'> {
  return {
    headless: (headless ? 'new' : false) as LaunchOptions['headless'],
  };
}

export async function launchBrowser(headless: boolean) {
  return puppeteer.launch({
    ...getLaunchOptions(headless),
  });
}
