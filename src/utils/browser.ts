import puppeteer from 'puppeteer';
import type { LaunchOptions } from 'puppeteer';

/** MN automation targets Chromium `headless: 'new'`; cast for Puppeteer launch typing drift. */
export function getLaunchOptions(headless: boolean): Pick<LaunchOptions, 'headless'> {
  const options: Pick<LaunchOptions, 'headless'> & { userDataDir?: string } = {
    headless: (headless ? 'new' : false) as LaunchOptions['headless'],
  };
  if (process.env.PUPPETEER_USER_DATA_DIR?.trim()) {
    options.userDataDir = process.env.PUPPETEER_USER_DATA_DIR.trim();
  }
  return options;
}

export async function launchBrowser(headless: boolean) {
  return puppeteer.launch({
    ...getLaunchOptions(headless),
  });
}
