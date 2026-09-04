import { describe, expect, it } from 'vitest';
import {
  reconcileLeads,
  formatLeadAnswer,
  parseLeadAnswer,
  shouldDeclineLead,
  type HarvestedLead,
  type StoredLead,
} from '../src/tasks/leads.js';

function lead(overrides: Partial<HarvestedLead> = {}): HarvestedLead {
  return {
    email: 'jane@example.com',
    name: 'Jane Doe',
    status: 'Pending',
    dateRequested: '2026-08-01',
    answers: ['I want to connect.'],
    ...overrides,
  };
}

describe('leads', () => {
  it('keeps each answer pair delimited and round-trippable', () => {
    const stored = formatLeadAnswer('What interests you?', 'Community and inquiry.');
    expect(stored).toBe('What interests you?\n\n--- Answer ---\nCommunity and inquiry.');
    expect(parseLeadAnswer(stored)).toEqual({
      question: 'What interests you?',
      answer: 'Community and inquiry.',
    });
  });

  it('adds new leads, updates changed statuses, and marks missing leads declined', () => {
    const existing: StoredLead[] = [
      {
        id: 1,
        ...lead({ email: 'jane@example.com', status: 'Pending' }),
        emailSentAt: null,
        emailCount: 0,
        dispositionAt: null,
      },
      {
        id: 2,
        ...lead({ email: 'old@example.com', status: 'Email sent' }),
        emailSentAt: '2026-07-01T00:00:00.000Z',
        emailCount: 1,
        dispositionAt: null,
      },
    ];

    const result = reconcileLeads(existing, [
      lead({ email: 'jane@example.com', status: 'Email sent' }),
      lead({ email: 'new@example.com' }),
    ]);

    expect(result.added.map((item) => item.email)).toEqual(['new@example.com']);
    expect(result.statusChanges).toEqual([
      { email: 'jane@example.com', from: 'Pending', to: 'Email sent' },
    ]);
    expect(result.declined.map((item) => item.email)).toEqual(['old@example.com']);
  });

  it('declines only email-sent leads at least one month old', () => {
    const now = new Date('2026-09-03T12:00:00.000Z');
    expect(shouldDeclineLead({ status: 'Email sent', emailSentAt: '2026-08-03T12:00:00.000Z' }, now)).toBe(true);
    expect(shouldDeclineLead({ status: 'Email sent', emailSentAt: '2026-08-04T12:00:00.000Z' }, now)).toBe(false);
    expect(shouldDeclineLead({ status: 'Pending', emailSentAt: '2026-07-01T00:00:00.000Z' }, now)).toBe(false);
    expect(shouldDeclineLead({ status: 'Email sent', emailSentAt: null }, now)).toBe(false);
  });
});