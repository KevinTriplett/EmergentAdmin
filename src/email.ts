import nodemailer from 'nodemailer';

/**
 * Admin recipients for end-of-run log emails. Hard-coded per `project_spec.md`:
 * "email the log ... to admin email addresses hard coded into an array,
 * populated initially with kt@kevintriplett.com".
 */
export const ADMIN_EMAILS: readonly string[] = ['kt@kevintriplett.com'];

export type RunLogOutcome = 'success' | 'error';

export type RunLogEmailPayload = {
  taskName: string;
  outcome: RunLogOutcome;
  summary: string;
  logLines: readonly string[];
  result: unknown;
  /**
   * Optional HTML *fragment* (NOT a full document) inserted between the
   * email envelope's header and the log section. Trusted — passed through
   * verbatim. The job that produces it is responsible for escaping any
   * untrusted input it interpolates (member names, comment text, etc.)
   * before stitching the fragment together. When undefined, the email is
   * sent as plain-text only (preserves existing behavior for tasks that
   * don't opt in).
   */
  htmlBody?: string;
};

type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

export type DirectEmail = {
  from: string;
  to: readonly string[];
  subject: string;
  text: string;
  html?: string;
};

/**
 * Read SMTP config from the environment. Returns null if any required field
 * is missing or the port isn't a number — both are "silently skip sending"
 * conditions, not hard errors, so local/dev runs never crash on a missing
 * mailer.
 */
function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM ?? user;
  if (!host || !portRaw || !user || !pass || !from) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port)) return null;
  return { host, port, user, pass, from };
}

export async function sendDirectEmail(message: DirectEmail): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  const smtp = readSmtpConfig();
  if (!smtp || message.to.length === 0) return;
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  await transporter.sendMail({
    from: message.from,
    to: message.to.join(', '),
    subject: message.subject,
    text: message.text,
    ...(message.html !== undefined ? { html: message.html } : {}),
  });
}

function formatBody(payload: RunLogEmailPayload): string {
  const header = [
    `Task: ${payload.taskName}`,
    `Outcome: ${payload.outcome.toUpperCase()}`,
    `Summary: ${payload.summary}`,
    `Timestamp: ${new Date().toISOString()}`,
  ].join('\n');

  const log = payload.logLines.length > 0
    ? payload.logLines.join('\n')
    : '(no log lines)';

  const result = (() => {
    try {
      return JSON.stringify(payload.result, null, 2);
    } catch {
      return String(payload.result);
    }
  })();

  return `${header}\n\n--- Log ---\n${log}\n\n--- Result ---\n${result}\n`;
}

/** Minimal HTML escape for caller-controlled strings interpolated into the envelope. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Compose the HTML email body. Header / log / result fields are escaped;
 * the job-supplied `htmlBody` fragment is trusted and inlined verbatim.
 * Returns a complete `<html>…</html>` document so SMTP servers don't have
 * to wrap it themselves.
 */
function formatHtmlBody(payload: RunLogEmailPayload): string {
  const ts = new Date().toISOString();
  const headerHtml = `
    <p style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px">
      <strong>Task:</strong> ${escapeHtml(payload.taskName)}<br>
      <strong>Outcome:</strong> ${escapeHtml(payload.outcome.toUpperCase())}<br>
      <strong>Summary:</strong> ${escapeHtml(payload.summary)}<br>
      <strong>Timestamp:</strong> ${escapeHtml(ts)}
    </p>`;

  const main = payload.htmlBody ?? '';

  const logHtml = payload.logLines.length > 0
    ? `<pre style="font-size:12px;white-space:pre-wrap">${escapeHtml(
        payload.logLines.join('\n'),
      )}</pre>`
    : '<p>(no log lines)</p>';

  const resultStr = (() => {
    try {
      return JSON.stringify(payload.result, null, 2);
    } catch {
      return String(payload.result);
    }
  })();
  const resultHtml = `<pre style="font-size:12px;white-space:pre-wrap">${escapeHtml(resultStr)}</pre>`;

  return `<!doctype html><html><body>
    ${headerHtml}
    ${main}
    <h3>Log</h3>
    ${logHtml}
    <h3>Result</h3>
    ${resultHtml}
  </body></html>`;
}

/**
 * Send an end-of-run log email to `ADMIN_EMAILS`.
 *
 * This is a no-op in three cases — all silent, none thrown — so that the hot
 * path never cares whether email is "on":
 *
 *   1. `NODE_ENV !== 'production'` — local dev runs never email.
 *   2. SMTP env vars missing or malformed.
 *   3. The admin list is empty.
 *
 * Caller should treat this as fire-and-forget; any network errors reject the
 * returned promise but should not be allowed to affect the HTTP response to
 * the user.
 */
export async function sendRunLogEmail(payload: RunLogEmailPayload): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  const smtp = readSmtpConfig();
  if (!smtp) return;
  if (ADMIN_EMAILS.length === 0) return;

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  const subject = `[MN Host Automator] ${payload.taskName} — ${payload.summary}`;

  /* Always send plain text. When the job opts in via `htmlBody`, also send
   * an HTML alternative — nodemailer composes a multipart/alternative
   * envelope and recipients see whichever their client prefers. */
  await transporter.sendMail({
    from: smtp.from,
    to: ADMIN_EMAILS.join(', '),
    subject,
    text: formatBody(payload),
    ...(payload.htmlBody !== undefined ? { html: formatHtmlBody(payload) } : {}),
  });
}
