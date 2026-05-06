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

  it('omits the html field when no htmlBody is provided (default text-only path)', async () => {
    setProductionSmtpEnv();

    const { sendRunLogEmail } = await import('../src/email.js');
    await sendRunLogEmail(samplePayload);

    const sendArgs = sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(sendArgs.text).toBeTypeOf('string');
    expect(sendArgs.html).toBeUndefined();
  });

  it('forwards an html multipart when htmlBody is provided, alongside the text part', async () => {
    setProductionSmtpEnv();

    const { sendRunLogEmail } = await import('../src/email.js');
    await sendRunLogEmail({
      ...samplePayload,
      htmlBody: '<ul><li><a href="https://example.test/u/1">Alice</a></li></ul>',
    });

    const sendArgs = sendMail.mock.calls[0][0] as { text: string; html: string };
    expect(sendArgs.text).toContain('SUCCESS');
    expect(sendArgs.html).toBeTypeOf('string');
    /* The generated HTML must keep the job-supplied fragment intact (anchors
     * survive escaping) AND wrap it in a standard envelope so the email is a
     * valid HTML doc with the same header info as the text body. */
    expect(sendArgs.html).toContain(
      '<a href="https://example.test/u/1">Alice</a>',
    );
    expect(sendArgs.html).toContain('removeSpaceMembers');
    expect(sendArgs.html).toContain('3 removed');
  });

  it('escapes header / log fields injected into the html envelope to avoid breaking markup', async () => {
    setProductionSmtpEnv();

    const { sendRunLogEmail } = await import('../src/email.js');
    await sendRunLogEmail({
      ...samplePayload,
      taskName: 'task <x> & co',
      logLines: ['log <a> & b'],
      htmlBody: '<p>ok</p>',
    });

    const sendArgs = sendMail.mock.calls[0][0] as { html: string };
    expect(sendArgs.html).toContain('task &lt;x&gt; &amp; co');
    expect(sendArgs.html).toContain('log &lt;a&gt; &amp; b');
    /* The trusted htmlBody fragment must NOT be escaped — it's the whole
     * point of the API. The job is responsible for escaping its own inputs. */
    expect(sendArgs.html).toContain('<p>ok</p>');
  });
});
