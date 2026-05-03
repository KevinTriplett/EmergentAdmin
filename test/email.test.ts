import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `sendRunLogEmail` is intentionally conservative: it *silently* no-ops
 * unless NODE_ENV === "production" AND every SMTP_* env var is set. These
 * tests pin that behavior so a future edit can't accidentally start sending
 * real mail from a developer laptop.
 *
 * We mock `nodemailer` at the module level and inspect whether its transport
 * factory got called — that's the only side-effect worth observing here.
 */

const createTransport = vi.fn();
const sendMail = vi.fn().mockResolvedValue({ accepted: ['kt@kevintriplett.com'] });
vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: unknown[]) => createTransport(...args) },
}));

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;

function clearSmtpEnv(): void {
  for (const key of SMTP_KEYS) delete process.env[key];
  delete process.env.NODE_ENV;
}

function setProductionSmtpEnv(): void {
  process.env.NODE_ENV = 'production';
  process.env.SMTP_HOST = 'smtp.test.example';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'user';
  process.env.SMTP_PASS = 'pass';
  process.env.SMTP_FROM = 'bot@example.com';
}

const samplePayload = {
  taskName: 'removeSpaceMembers on "Marketplace"',
  outcome: 'success' as const,
  summary: '3 removed',
  logLines: ['line 1', 'line 2'],
  result: { success: true, removed: 3 },
};

describe('sendRunLogEmail', () => {
  beforeEach(() => {
    createTransport.mockReset();
    sendMail.mockClear();
    createTransport.mockReturnValue({ sendMail });
    clearSmtpEnv();
  });

  afterEach(() => {
    clearSmtpEnv();
  });

  it('no-ops when NODE_ENV is not production', async () => {
    setProductionSmtpEnv();
    process.env.NODE_ENV = 'development';

    const { sendRunLogEmail } = await import('../src/email.js');
    await sendRunLogEmail(samplePayload);

    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('no-ops when SMTP_HOST is missing even in production', async () => {
    setProductionSmtpEnv();
    delete process.env.SMTP_HOST;

    const { sendRunLogEmail } = await import('../src/email.js');
    await sendRunLogEmail(samplePayload);

    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends when NODE_ENV=production and SMTP env vars are set', async () => {
    setProductionSmtpEnv();

    const { sendRunLogEmail, ADMIN_EMAILS } = await import('../src/email.js');
    await sendRunLogEmail(samplePayload);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);

    const sendArgs = sendMail.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
      from: string;
    };
    expect(sendArgs.to).toBe(ADMIN_EMAILS.join(', '));
    expect(sendArgs.subject).toContain('removeSpaceMembers');
    expect(sendArgs.subject).toContain('3 removed');
    expect(sendArgs.text).toContain('line 1');
    expect(sendArgs.text).toContain('line 2');
    expect(sendArgs.text).toContain('SUCCESS');
  });
});
