import { describe, it, expect } from 'vitest';
import { abortedRemovalMessage } from '../src/abortRemoval.js';

describe('abortedRemovalMessage', () => {
  it('formats count for zero removals', () => {
    expect(abortedRemovalMessage(0)).toBe('Aborted by user after 0 removals');
  });

  it('formats count for positive removals', () => {
    expect(abortedRemovalMessage(1)).toBe('Aborted by user after 1 removals');
    expect(abortedRemovalMessage(12)).toBe('Aborted by user after 12 removals');
  });
});
