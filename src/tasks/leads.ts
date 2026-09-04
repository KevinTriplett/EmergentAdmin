import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Page } from 'puppeteer';
import { loginIfNeeded, type LogFn } from '../auth.js';

export const LEADS_URL = 'https://emergent-commons.mn.co/admin/leads';
export const LEADS_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 } as const;
export const MAX_LEADS = 500;
export const SEL_LEADS_TAB = "table[aria-label='desktop data table']";
export const SEL_LEAD_ROWS = `${SEL_LEADS_TAB} tbody [data-id='table-row']`;
export const SEL_REVEAL_EMAILS = `${SEL_LEADS_TAB} [aria-label='Reveal Email column']`;
export const SEL_MODAL_CONFIRM = "[role='dialog'] button";
export const SEL_ANSWERS_LIST = 'h2#view-answers-dialog-title ~ ol';
export const LEAD_ANSWER_DELIMITER = '\n\n--- Answer ---\n';
export const EMAIL_LEAD_SUBJECT = 'Meet a greeter at Emergent Commons';
export const EMAIL_LEAD_FROM = 'kt@kevintriplett.com';
export const GREETER_EMAILS = ['kt@kevintriplett.com'] as const;
export const EMAIL_GREETERS_SUBJECT = '[Emergent Commons] Greeters: new leads available to check';
export const EMAIL_LEAD_BODY = `Hello,

Thank you for asking to join Emergent Commons.

Before entering, we want to greet you and get to know what interests you in our community so we can help you find what you're looking for. We're a big, diverse group with a Commons and Crews.

The Commons is where we discuss topics of interest to all members and our Crews are where we discuss and practice specific topics and modalities.

Choose a time that suits you using this link:

https://calendly.com/kevintriplett/emergent-commons-welcome

I'm looking forward to greeting you!
Best regards,
Kevin Triplett`;

export type LeadStatus = 'Pending' | 'Email sent' | 'Response received' | 'Joined' | 'Declined';

export type HarvestedLead = {
  name: string;
  email: string;
  status: LeadStatus;
  dateRequested: string;
  answers: string[];
};

export type StoredLead = HarvestedLead & {
  id: number;
  emailSentAt: string | null;
  emailCount: number;
  dispositionAt: string | null;
};

export type LeadStatusChange = { email: string; from: LeadStatus; to: LeadStatus };

export type LeadReconciliation = {
  added: HarvestedLead[];
  statusChanges: LeadStatusChange[];
  declined: StoredLead[];
};

export function formatLeadAnswer(question: string, answer: string): string {
  return `${question.trim()}${LEAD_ANSWER_DELIMITER}${answer.trim()}`;
}

export function parseLeadAnswer(storedAnswer: string): { question: string; answer: string } {
  const delimiterIndex = storedAnswer.indexOf(LEAD_ANSWER_DELIMITER);
  if (delimiterIndex < 0) return { question: storedAnswer.trim(), answer: '' };
  return {
    question: storedAnswer.slice(0, delimiterIndex).trim(),
    answer: storedAnswer.slice(delimiterIndex + LEAD_ANSWER_DELIMITER.length).trim(),
  };
}

export function reconcileLeads(existing: readonly StoredLead[], harvested: readonly HarvestedLead[]): LeadReconciliation {
  const byEmail = new Map(existing.map((item) => [item.email.toLowerCase(), item]));
  const harvestedEmails = new Set<string>();
  const added: HarvestedLead[] = [];
  const statusChanges: LeadStatusChange[] = [];

  for (const item of harvested) {
    const key = item.email.toLowerCase();
    harvestedEmails.add(key);
    const prior = byEmail.get(key);
    if (!prior) {
      added.push(item);
    } else if (prior.status !== item.status) {
      statusChanges.push({ email: prior.email, from: prior.status, to: item.status });
    }
  }

  const declined = existing.filter((item) => !harvestedEmails.has(item.email.toLowerCase()) && item.status !== 'Declined');
  return { added, statusChanges, declined };
}

export function shouldDeclineLead(
  lead: Pick<StoredLead, 'status' | 'emailSentAt'>,
  now: Date,
): boolean {
  if (lead.status !== 'Email sent' || lead.emailSentAt === null) return false;
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
  return new Date(lead.emailSentAt).getTime() <= cutoff.getTime();
}

export type LeadsStore = {
  list(): StoredLead[];
  getByEmail(email: string): StoredLead | null;
  insert(lead: HarvestedLead): StoredLead;
  updateAnswers(email: string, answers: string[]): void;
  updateStatus(email: string, status: LeadStatus, when?: string): void;
  markEmailSent(email: string, when?: string): StoredLead;
  close(): void;
};

export function openLeadsStore(filePath = 'data/ec-admin.db'): LeadsStore {
  const db: SqliteDatabase = new Database(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      status TEXT NOT NULL,
      date_requested TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      email_sent_at TEXT,
      email_count INTEGER NOT NULL DEFAULT 0,
      disposition_at TEXT
    );
  `);
  const select = db.prepare('SELECT * FROM leads ORDER BY date_requested DESC, id DESC');
  const map = (row: Record<string, unknown>): StoredLead => ({
    id: Number(row.id), name: String(row.name), email: String(row.email), status: row.status as LeadStatus,
    dateRequested: String(row.date_requested), answers: JSON.parse(String(row.answers_json)) as string[],
    emailSentAt: row.email_sent_at === null ? null : String(row.email_sent_at),
    emailCount: Number(row.email_count), dispositionAt: row.disposition_at === null ? null : String(row.disposition_at),
  });
  const find = db.prepare('SELECT * FROM leads WHERE email = ?');
  return {
    list: () => (select.all() as Record<string, unknown>[]).map(map),
    getByEmail: (email) => { const row = find.get(email) as Record<string, unknown> | undefined; return row ? map(row) : null; },
    insert: (lead) => {
      const result = db.prepare(`INSERT INTO leads (name, email, status, date_requested, answers_json) VALUES (?, ?, ?, ?, ?)`)
        .run(lead.name, lead.email, lead.status, lead.dateRequested, JSON.stringify(lead.answers));
      return map(find.get(lead.email) as Record<string, unknown>);
    },
    updateAnswers: (email, answers) => {
      db.prepare('UPDATE leads SET answers_json = ? WHERE email = ?').run(JSON.stringify(answers), email);
    },
    updateStatus: (email, status, when = new Date().toISOString()) => {
      db.prepare(`UPDATE leads SET status = ?, disposition_at = CASE WHEN ? IN ('Joined', 'Declined') THEN ? ELSE disposition_at END WHERE email = ?`)
        .run(status, status, when, email);
    },
    markEmailSent: (email, when = new Date().toISOString()) => {
      db.prepare(`UPDATE leads SET status = 'Email sent', email_sent_at = ?, email_count = email_count + 1 WHERE email = ?`).run(when, email);
      return map(find.get(email) as Record<string, unknown>);
    },
    close: () => db.close(),
  };
}

export type LeadHarvestDeps = { page: Page; log: LogFn; maxLeads?: number; abortSignal?: { aborted: boolean } };

export async function harvestLeads({ page, log, maxLeads = MAX_LEADS, abortSignal }: LeadHarvestDeps): Promise<HarvestedLead[]> {
  await page.setViewport(LEADS_VIEWPORT);
  await page.goto(LEADS_URL, { waitUntil: 'domcontentloaded' });
  await loginIfNeeded(page, log);
  await page.waitForSelector(SEL_LEAD_ROWS, { timeout: 60_000 });
  await page.evaluate(async (limit) => {
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const rows = document.querySelectorAll("table[aria-label='desktop data table'] tbody [data-id='table-row']");
      if (rows.length >= limit) break;
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, maxLeads);
  const revealButton = await page.$(SEL_REVEAL_EMAILS);
  if (revealButton) {
    await revealButton.click();
    await page.waitForSelector(SEL_MODAL_CONFIRM, { timeout: 10_000 });
    const confirmed = await page.evaluate(() => {
      for (const button of document.querySelectorAll("[role='dialog'] button")) {
        if (button.textContent?.trim() === 'Okay') {
          (button as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (!confirmed) throw new Error('Could not find the Member Privacy Reminder Okay button');
    await page.waitForSelector(`${SEL_LEADS_TAB} [aria-label='Hide Email column']`, { timeout: 10_000 });
  }
  const rows = await page.evaluate((limit) => Array.from(document.querySelectorAll("[data-tab='leads'] tbody [data-id='table-row']")).slice(0, limit).map((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim() ?? '');
      const email = row.querySelector('[data-email]')?.getAttribute('data-email') ?? cells[2];
      if (email.includes('***@***.***')) throw new Error('Email column is still masked after reveal confirmation');
      return { name: cells[1], email, status: cells[3] as LeadStatus, dateRequested: cells[5], answers: [] };
    }).filter((item) => item.email.length > 0), maxLeads) as HarvestedLead[];
  for (const row of rows) {
    if (abortSignal?.aborted) break;
    const opened = await page.evaluate((email) => {
      for (const item of document.querySelectorAll("table[aria-label='desktop data table'] tbody [data-id='table-row']")) {
        if ((item.textContent ?? '').includes(email)) {
          const button = Array.from(item.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === 'View Answers');
          if (button) { (button as HTMLElement).click(); return true; }
        }
      }
      return false;
    }, row.email);
    if (opened) {
      await page.waitForSelector(SEL_ANSWERS_LIST, { timeout: 5_000 });
      row.answers = await page.$$eval(`${SEL_ANSWERS_LIST} li`, (items) => items.map((item) => {
        const question = item.children[0]?.textContent?.trim() ?? '';
        const answer = item.children[1]?.textContent?.trim() ?? '';
        return `${question}\n\n--- Answer ---\n${answer}`;
      }));
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
  return rows;
}

export type LeadActionResult = { success: boolean; email: string; status: LeadStatus; error?: string };

export async function approveLead(page: Page, email: string, log: LogFn): Promise<LeadActionResult> {
  try {
    await page.setViewport(LEADS_VIEWPORT);
    await page.goto(LEADS_URL, { waitUntil: 'domcontentloaded' });
    await loginIfNeeded(page, log);
    const clicked = await page.evaluate((target) => {
      for (const row of document.querySelectorAll("table[aria-label='desktop data table'] tbody [data-id='table-row']")) {
        if ((row.textContent ?? '').includes(target)) {
          const button = Array.from(row.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Approve');
          if (button) { (button as HTMLElement).click(); return true; }
        }
      }
      return false;
    }, email);
    if (!clicked) throw new Error(`Could not find Approve action for ${email}`);
    return { success: true, email, status: 'Joined' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, email, status: 'Pending', error: message };
  }
}

export async function declineLead(page: Page, email: string, log: LogFn): Promise<LeadActionResult> {
  try {
    await page.setViewport(LEADS_VIEWPORT);
    await page.goto(LEADS_URL, { waitUntil: 'domcontentloaded' });
    await loginIfNeeded(page, log);
    const found = await page.evaluate((target) => {
      for (const row of document.querySelectorAll("table[aria-label='desktop data table'] tbody [data-id='table-row']")) {
        if ((row.textContent ?? '').includes(target)) {
          const buttons = Array.from(row.querySelectorAll('button'));
          const button = buttons[buttons.length - 1];
          if (button) { (button as HTMLElement).click(); return true; }
        }
      }
      return false;
    }, email);
    if (!found) throw new Error(`Could not find decline action for ${email}`);
    await page.waitForSelector("ul[role='menu']", { timeout: 10_000 });
    const menus = await page.$$eval("ul[role='menu']", (items) => items.length);
    if (menus !== 1) throw new Error(`Expected one decline menu, found ${menus}`);
    await page.click("ul[role='menu']");
    await page.waitForSelector("form[novalidate] button[type='submit']", { timeout: 10_000 });
    await page.click("form[novalidate] button[type='submit']");
    return { success: true, email, status: 'Declined' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, email, status: 'Pending', error: message };
  }
}

export function buildHarvestLeadsJob(
  store: LeadsStore,
  sendGreeterEmail: ((message: { from: string; to: string; subject: string; text: string }) => Promise<void>) | undefined,
  headless = true,
) {
  return {
    name: 'harvest-leads',
    headless,
    run: async ({ page, log }: { page: Page; log: LogFn }) => {
      const harvested = await harvestLeads({ page, log });
      const existing = store.list();
      const reconciliation = reconcileLeads(existing, harvested);
      for (const item of reconciliation.added) store.insert(item);
      for (const item of harvested) {
        if (existing.some((prior) => prior.email.toLowerCase() === item.email.toLowerCase())) {
          store.updateAnswers(item.email, item.answers);
        }
      }
      for (const change of reconciliation.statusChanges) store.updateStatus(change.email, change.to);
      for (const item of reconciliation.declined) store.updateStatus(item.email, 'Declined');
      if (reconciliation.added.length > 0 && sendGreeterEmail) {
        await sendGreeterEmail({
          from: EMAIL_LEAD_FROM, to: GREETER_EMAILS.join(', '), subject: EMAIL_GREETERS_SUBJECT,
          text: `New leads are available:\n\n${reconciliation.added.map((item) => `${item.name}: ${LEADS_URL}`).join('\n')}`,
        });
      }
      return reconciliation;
    },
    summarize: (result: LeadReconciliation) => `${result.added.length} new lead(s)`,
  };
}

export function buildDeclineStaleLeadsJob(store: LeadsStore, headless = true) {
  return {
    name: 'decline-stale-leads',
    headless,
    run: async ({ page, log }: { page: Page; log: LogFn }) => {
      const stale = store.list().filter((item) => shouldDeclineLead(item, new Date()));
      const results: LeadActionResult[] = [];
      for (const item of stale) {
        const result = await declineLead(page, item.email, log);
        results.push(result);
        if (result.success) store.updateStatus(item.email, 'Declined');
      }
      return results;
    },
    summarize: (results: LeadActionResult[]) => `${results.filter((item) => item.success).length}/${results.length} stale lead(s) declined`,
  };
}