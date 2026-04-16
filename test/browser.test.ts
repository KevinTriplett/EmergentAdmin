import { describe, it, expect } from 'vitest';
import { getLaunchOptions } from '../src/utils/browser.js';

describe('getLaunchOptions', () => {
  it('uses new headless mode when headless is true', () => {
    expect(getLaunchOptions(true)).toEqual({ headless: 'new' });
  });

  it('disables headless when headless is false', () => {
    expect(getLaunchOptions(false)).toEqual({ headless: false });
  });
});
