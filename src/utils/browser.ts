import { promises as fs } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import type { LaunchOptions } from 'puppeteer';

const LINUX_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

const ACCOUNT_MARKER = '.account';

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

/**
 * Reads the account-binding marker inside `userDataDir` and deletes the whole
 * profile directory if it disagrees with `currentEmail`. This prevents a stale
 * MN session cookie from short-circuiting the login flow after MN_EMAIL has
 * been changed in .env. Returns true if the profile was reset.
 */
export async function maybeResetProfileForAccountSwitch(
  userDataDir: string,
  currentEmail: string | undefined,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  if (!currentEmail) return false;
  const markerPath = path.join(userDataDir, ACCOUNT_MARKER);
  let stored: string;
  try {
    stored = (await fs.readFile(markerPath, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!stored || stored === currentEmail) return false;
  log(
    `Puppeteer profile was bound to "${stored}"; MN_EMAIL is now "${currentEmail}". Resetting "${userDataDir}" to force a fresh login.`,
  );
  await fs.rm(userDataDir, { recursive: true, force: true });
  return true;
}

/**
 * Records which MN account the persistent profile is bound to. Called after a
 * successful authentication so the next launch can detect a mismatch.
 */
export async function writeProfileAccount(
  userDataDir: string,
  email: string,
): Promise<void> {
  if (!email) return;
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(path.join(userDataDir, ACCOUNT_MARKER), email, 'utf8');
}

export async function launchBrowser(headless: boolean) {
  const userDataDir = process.env.PUPPETEER_USER_DATA_DIR?.trim();
  if (userDataDir) {
    await maybeResetProfileForAccountSwitch(
      userDataDir,
      process.env.MN_EMAIL,
      (msg) => console.log(`[browser] ${msg}`),
    );
  }
  return puppeteer.launch(getLaunchOptions(headless));
}
