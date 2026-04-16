import puppeteer from 'puppeteer';
import type { LaunchOptions } from 'puppeteer';

const LINUX_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

export function getLaunchOptions(headless: boolean): LaunchOptions {
  const options: LaunchOptions & { userDataDir?: string } = {
    headless: (headless ? 'new' : false) as LaunchOptions['headless'],
    args: process.platform === 'linux' ? LINUX_ARGS : [],
  };
  if (process.env.PUPPETEER_USER_DATA_DIR?.trim()) {
    options.userDataDir = process.env.PUPPETEER_USER_DATA_DIR.trim();
  }
  return options;
}

export async function launchBrowser(headless: boolean) {
  return puppeteer.launch(getLaunchOptions(headless));
}
