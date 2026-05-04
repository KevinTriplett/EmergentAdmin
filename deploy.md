# Deploying EmergentAdmin on Debian 11 (Bullseye)

This guide assumes:

- Debian 11 (bullseye) server with root/sudo access
- nginx already installed and serving other sites
- Git SSH access to `git@github.com:KevinTriplett/EmergentAdmin.git`

---

## 1. Install Node.js via nvm

Node is managed per-user with [nvm](https://github.com/nvm-sh/nvm) so the version in the repo's `.nvmrc` is always authoritative.

First, install build prerequisites (nvm needs these to fetch the Node tarball):

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates build-essential
```

The remaining commands in this section should run as the **deploy user** (see section 3 — create it first if you haven't). As that user:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Load nvm into the current shell (new shells get it from ~/.bashrc automatically)
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

# Install whatever version the repo pins
cd ~/EmergentAdmin 2>/dev/null || true   # only works after section 4; otherwise skip
nvm install          # reads .nvmrc
nvm alias default "$(cat .nvmrc 2>/dev/null || echo lts/*)"

node -v              # should match .nvmrc
npm -v
```

> **Note:** If you haven't cloned the repo yet, just run `nvm install --lts` for now and re-run `nvm install` from inside the repo after section 4.

## 2. Install Chromium dependencies

Puppeteer downloads its own Chrome, but it needs these system libraries:

```bash
sudo apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
  libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxshmfence1 xdg-utils wget
```

## 3. Create app user (optional but recommended)

```bash
sudo useradd -m -s /bin/bash deploy
sudo su - deploy
```

All remaining commands in sections 4–6 run as this user (or your deploy user).

## 4. Clone and build

```bash
cd ~
git clone git@github.com:KevinTriplett/EmergentAdmin.git
cd EmergentAdmin

# Make sure nvm is loaded and the pinned Node version is active
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install            # reads .nvmrc and installs if missing
nvm use                # activates the .nvmrc version for this shell

npm ci
npm run install:browsers
npm run build
```

## 5. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your MN credentials and (optionally) SMTP config for admin
run-log emails:

```
MN_EMAIL=your@email.com
MN_PASSWORD=yourpassword
PUPPETEER_USER_DATA_DIR=.puppeteer-profile
PORT=3000

# Admin run-log email (see section 5.1). Leave commented out to disable.
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=smtp-username
# SMTP_PASS=smtp-password
# SMTP_FROM="MN Host Automator <bot@example.com>"
```

Because `.env` holds the SMTP password (and your MN password), tighten its
permissions so only the deploy user can read it:

```bash
chmod 600 .env
```

Verify it starts:

```bash
npm start
# Should print: MN Host Automator listening on http://localhost:3000
# Ctrl-C to stop
```

## 5.1 Admin run-log email (optional)

At the end of every `removeSpaceMembers` / `addSpaceMember` run — success *or*
error — the server emails the captured log to the admin list hard-coded in
`src/email.ts` (initially `kt@kevintriplett.com`). The feature is **off by
default** and is gated by two independent checks so a misconfigured staging
box can't accidentally spam admins:

1. `NODE_ENV === 'production'` — already set for you by the systemd unit in
  section 6 (`Environment=NODE_ENV=production`). In any other environment
   email sending is a silent no-op.
2. Every one of `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and
  `SMTP_FROM` must be set. If any is missing, email sending is again a
   silent no-op — the task still runs and returns normally.

Editing the admin recipient list is a code change:

```bash
# src/email.ts
export const ADMIN_EMAILS: readonly string[] = [
  'kt@kevintriplett.com',
  // add more addresses here, then redeploy (npm run build + systemctl restart)
];
```

SMTP credential options (any provider that speaks SMTP works):

- **Gmail / Google Workspace** — enable 2FA on the sending account, create an
[App Password](https://myaccount.google.com/apppasswords), then:
  ```
  SMTP_HOST=smtp.gmail.com
  SMTP_PORT=587
  SMTP_USER=you@gmail.com
  SMTP_PASS=<16-char app password>
  SMTP_FROM="MN Host Automator <you@gmail.com>"
  ```
- **SendGrid** — `SMTP_HOST=smtp.sendgrid.net`, `SMTP_PORT=587`,
`SMTP_USER=apikey`, `SMTP_PASS=<your SendGrid API key>`.
- **AWS SES** — use the region's SMTP endpoint (e.g.
`email-smtp.us-east-1.amazonaws.com`), port `587`, and SES SMTP credentials
(not your IAM keys). The `SMTP_FROM` address must be a verified sender.
- **Port 465** — if your provider requires implicit TLS on 465, set
`SMTP_PORT=465`; the code auto-switches to `secure: true` for that port.

After editing `.env`, restart the service:

```bash
sudo systemctl restart emergent-admin
```

To confirm email is wired up, run any task from the UI and then tail the
service logs. A successful send is silent in the journal; a failure prints
`sendRunLogEmail failed for "<task>": <error>` but does **not** affect the
task's HTTP response — email is strictly fire-and-forget.

## 5.2 Agreements Watcher (optional, Stage 4a)

The server can watch an IMAP mailbox for MN per-comment notifications and
auto-add members to all commons spaces once they've posted "I agree" on the
agreement article. Like run-log email, this is **off by default**: it
starts only when every one of the IMAP credentials below is set.

Add the following to `/home/deploy/EmergentAdmin/.env`:

```
# IMAP auth identity. Defaults to MN_EMAIL if omitted; set explicitly
# whenever MN_EMAIL is a forwarding alias and the real mailbox lives at
# a different address (Gmail App Passwords are keyed to the mailbox
# account, not the alias).
IMAP_USER=ec-bot@gmail.com
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_PASSWORD=<16-char Gmail App Password>
IMAP_MAILBOX=INBOX

# Optional - defaults to ./data/ec-admin.db under the working directory.
# EC_ADMIN_DB_PATH=/home/deploy/EmergentAdmin/data/ec-admin.db
```

**Gmail specifics.** With 2FA on (required for IMAP), you *must* create an
[App Password](https://myaccount.google.com/apppasswords) and use it as
`IMAP_PASSWORD` - your normal Gmail password will be rejected. The App
Password is tied to the mailbox account that owns it, so `IMAP_USER` must
match the Google account you generated the password under (not a Gmail
alias or workspace-forwarder address).

**Forwarding addresses.** If MN sends notifications to e.g.
`host@emergent-commons.org` and that address forwards to `ec-bot@gmail.com`,
the forwarded copy lands in Gmail with the original envelope intact - set
`IMAP_USER=ec-bot@gmail.com` (the mailbox) and leave `MN_EMAIL` as the
MN-login identity. They do not need to match.

**SQLite data directory.** The server writes to `./data/ec-admin.db`
relative to the service's working directory (by default the repo root).
Create it and make sure the deploy user owns it:

```bash
mkdir -p /home/deploy/EmergentAdmin/data
chown -R deploy:deploy /home/deploy/EmergentAdmin/data
chmod 700 /home/deploy/EmergentAdmin/data
```

**Backups.** The DB is the only durable state for agreements. A simple
nightly backup + age-based rotation is enough given the size. Drop both
jobs into one `cron.d` file so they ship and version together:

```bash
sudo tee /etc/cron.d/emergent-admin-backup > /dev/null <<'EOF'
# m h dom mon dow user  command
PATH=/usr/bin:/bin

# 03:30 - snapshot the EC admin DB to a date-stamped file. Use sqlite3's
# .backup so we get a consistent copy even while the service is writing
# (WAL-aware) instead of a torn `cp`.
30 3 * * * deploy sqlite3 /home/deploy/EmergentAdmin/data/ec-admin.db ".backup '/home/deploy/EmergentAdmin/data/ec-admin-$(date +\%F).db'"

# 03:35 - prune snapshots older than 14 days. Runs 5 minutes after the
# backup so today's file is never a deletion candidate.
35 3 * * * deploy find /home/deploy/EmergentAdmin/data -maxdepth 1 -name 'ec-admin-*.db' -mtime +14 -delete
EOF
sudo chmod 644 /etc/cron.d/emergent-admin-backup
```

Verify cron picked it up:

```bash
sudo systemctl reload cron       # not strictly required - cron rescans cron.d every minute
grep -H '' /etc/cron.d/emergent-admin-backup
sudo grep CRON /var/log/syslog | tail -5   # after the next 03:30/03:35 ticks
```

A few gotchas worth knowing:

- The literal `%` in `date +%F` **must** be escaped as `\%` inside cron — an unescaped `%` is treated as end-of-command and turns the rest into stdin, which fails silently.
- Files in `/etc/cron.d/` must be owned by root, mode `0644`, with no `.` in the filename, and **must end with a trailing newline** (the heredoc above already does).
- The `user` column (`deploy` here) is a `cron.d` thing — don't include it if you ever move these into `crontab -e -u deploy` instead.
- The prune job is intentionally separated by 5 minutes so a hypothetical clock-skew or slow backup never wipes the file it just wrote.

After editing `.env`, restart and confirm the poller started:

```bash
sudo systemctl restart emergent-admin
sudo journalctl -u emergent-admin -n 50 --no-pager
# Should include: "Agreements watcher: IMAP poller started (user=...)"
```

Note: the agreement article ID in `src/config/agreements.ts` is the
numeric `articleId` from the MN deep link (e.g. `https://app.mn.co/<n>/spaces/<spaceId>/posts/<articleId>/comments/<commentId>?...`).
If that post is ever republished or migrated, update both `articleId` and
`spaceId` in `AGREEMENT_ARTICLES`, rebuild, and restart. Until the IDs match
a real MN post, the poller will skip every incoming comment as the safe
failure mode.

### Commons membership reconcile (Stage 4c)

When agreements are persisted in SQLite, you can periodically **repair commons
membership**: for every member whose distinct agreement article count meets
the threshold (`AGREEMENT_ARTICLES.length` → `REQUIRED_AGREEMENT_COUNT` in
`src/config/agreements.ts`, threaded into SQLite via `openAgreementsStore`),
the server enqueues one background `add-member-to-all-spaces` job. That reruns Puppeteer membership against every
configured space — idempotent for members already added, corrective for misses.

This uses the **same** `TaskScheduler` background queue as the IMAP poller's
automatic adds — not a second browser runner.

- **`RECONCILE_COMMONS_CRON`** — optional standard [node-cron](https://www.npmjs.com/package/node-cron) expression (trimmed env value). Example for 02:30 daily in the server's local timezone: `30 2 * * *`. Scheduled only when the agreements SQLite store opens successfully (same conditions as Stage 4a watcher data + app config).
- **`IMAP_POLL_INTERVAL_MS`** — optional millisecond gap between inbox polls when the agreements watcher runs (default `300000`).
- **`POST /run/reconcile-commons-membership`** — same semantics as `/run/remove-space-members`; responds with JSON `{ enqueued, members }`. Use **`curl`/CI**, or the **`Enqueue reconcile`** control in **`public/index.html`** when the agreements store is enabled.

- **`GET /status/agreements`** — read-only `{ db, imap, configuredAgreementArticles }` blob for dashboards (authored primarily for **`public/index.html`**). Omit when SQLite is off (`404`).
- **`POST /run/poll-agreements-mailbox`** — invokes one IMAP ingestion round-trip (same semantics as timer ticks); returns **`PollResult` JSON**. Returns **`404`** if the watcher hook is absent (manual Node tests / dev stubs).
Restart the unit after editing `.env` so cron registration picks up schedule changes.

## 5.3 Verifying the Agreements Watcher

Run these checks in order after first-time setup or any time you change
IMAP credentials. Each one isolates a single failure mode and produces an
obvious pass/fail signal.

### Test 1 — IMAP credentials authenticate at all

Cheapest possible check. From the deploy box (as the deploy user), use the
**same** `IMAP_USER` and 16-char App Password (no spaces) that are in `.env`:

```bash
sudo apt-get install -y openssl   # if missing
openssl s_client -crlf -quiet -connect imap.gmail.com:993 <<EOF
A1 LOGIN ec-bot@gmail.com xxxxxxxxxxxxxxxx
A2 LIST "" "*"
A3 LOGOUT
EOF
```

**Pass:** `A1 OK` followed by a `* LIST (...) "/" "INBOX"` listing.
**Fail (`A1 NO`):** wrong password, wrong account, IMAP not enabled in
Gmail settings, or the App Password belongs to a different Google account
than `IMAP_USER`. Fix before moving on.

### Test 2 — Service is actively polling

Watch the journal for ~70 seconds (the poller ticks roughly every minute):

```bash
sudo journalctl -u emergent-admin -f --since '2 minutes ago'
```

Expect either quiet idle ticks (fine — no new mail) or `[imap] imapPoller: ...`
lines on activity. Repeating IMAP errors (`auth failed`, `ECONNREFUSED`,
`ETIMEDOUT`) mean the credentials/host/port are still wrong; fix `.env`
and `sudo systemctl restart emergent-admin`.

### Test 3 — DB schema initialized

Confirm the SQLite file was created on first boot:

```bash
sqlite3 /home/deploy/EmergentAdmin/data/ec-admin.db ".tables"
# expect: agreements  dms_sent  members  processed_emails

sqlite3 /home/deploy/EmergentAdmin/data/ec-admin.db \
  "SELECT count(*) FROM processed_emails;"
# expect: 0  (nothing seen yet)
```

### Test 4 — Synthetic notification through the real mailbox

Goal: prove parser + dedup + store all work end-to-end on a real IMAP
delivery, *without* needing a test MN member yet.

From any machine that can SMTP into the receiving Gmail, send an email
**to** `IMAP_USER` that mimics MN's format. Either forward yourself one
of the real notification emails you've previously received from MN, or
craft one with `swaks`:

```bash
swaks --to ec-bot@gmail.com \
  --from "MN Notifications <noreply@mn.co>" \
  --header "Subject: Test User commented on your Article: I agree" \
  --header 'Message-Id: <smoke-test-1@local>' \
  --body 'Visit https://app.mn.co/12345/posts/<REAL-ARTICLE-ID>/comments/99999 to reply.'
```

Replace `<REAL-ARTICLE-ID>` with one of the 8 real IDs you populated in
`src/config/agreements.ts`. Wait ~90 s, then inspect:

```bash
sqlite3 /home/deploy/EmergentAdmin/data/ec-admin.db \
  "SELECT message_id, processed_at FROM processed_emails ORDER BY processed_at DESC LIMIT 5;"

sqlite3 /home/deploy/EmergentAdmin/data/ec-admin.db \
  "SELECT m.full_name, a.member_id, a.article_id, a.commented_at, a.source
   FROM agreements a JOIN members m ON a.member_id = m.member_id
   ORDER BY a.commented_at DESC LIMIT 5;"
```

**Pass:** new rows in both `processed_emails` and `agreements` (the latter
with `source='email'`), plus a row in `members`.
**Fail (no rows in agreements):** parser didn't match, or the URL's
`articleId` isn't in `AGREEMENT_ARTICLES`. Look for `[imap]` warnings in
the journal.

### Test 5 — Replay is idempotent (dedup works)

Re-send the **exact same** message (same `Message-Id`):

```bash
swaks --to ec-bot@gmail.com --from "MN Notifications <noreply@mn.co>" \
  --header "Subject: Test User commented on your Article: I agree" \
  --header 'Message-Id: <smoke-test-1@local>' \
  --body 'Visit https://app.mn.co/12345/posts/<REAL-ARTICLE-ID>/comments/99999 to reply.'
```

After ~90 s, the `processed_emails` row count should be **unchanged**.
The journal will note the duplicate uid was skipped. This proves restarts
and re-deliveries are safe.

### Test 6 — Malformed comment path

Send a notification whose body is anything other than "I agree":

```bash
swaks --to ec-bot@gmail.com --from "MN Notifications <noreply@mn.co>" \
  --header "Subject: Test User commented on your Article: lol whatever" \
  --header 'Message-Id: <smoke-test-2@local>' \
  --body 'Visit https://app.mn.co/12345/posts/<REAL-ARTICLE-ID>/comments/99998 to reply.'
```

In the journal you should see:

```
[imap] imapPoller: malformed agreement comment from Test User (...) on ...: "lol whatever" (DM trigger not wired)
```

The `(DM trigger not wired)` tail is expected for now — Stage 4b will
replace that log with an actual DM enqueue.

### Test 7 — Real-world end-to-end with a test member

Once Tests 1–6 are green, do the production rehearsal:

1. Create a throwaway MN member account (or use a coworker's test account).
2. Have them post `I agree` on the agreement article.
3. Wait for the email to land in the receiving Gmail (verify via Gmail's
   web UI).
4. Within a poll cycle (≤ 60 s after delivery), check:

   ```bash
   sqlite3 /home/deploy/EmergentAdmin/data/ec-admin.db \
     "SELECT m.full_name, a.article_id, a.commented_at FROM agreements a
      JOIN members m ON a.member_id = m.member_id
      ORDER BY a.commented_at DESC LIMIT 5;"
   ```

5. The same row that lands in `agreements` is also the threshold trigger
   (currently `REQUIRED_AGREEMENT_COUNT = 1`), so the journal should show:

   ```
   [imap] imapPoller: member <full name> (<id>) reached required agreements - add-all-spaces enqueued
   ```

   followed shortly after by the usual `═══ Adding to space: ... ═══` log
   lines from the auto-triggered add-all-spaces job. Verify on MN that the
   member now appears in all spaces.

### Test 8 — Restart resilience

```bash
sudo systemctl restart emergent-admin
sleep 5
sudo journalctl -u emergent-admin -n 30 --no-pager | grep -E 'IMAP|listening'
```

Confirm both lines reappear: `MN Host Automator listening on ...` and
`Agreements watcher: IMAP poller started (user=...)`. Send the same
`<smoke-test-1@local>` email a third time — still no new DB rows. The
poller's "we already processed this" memory survives restart because it's
in SQLite.

## 5.4 Agreements Watcher: triage

Quick lookup table for the most common failure modes. All commands run
on the deploy box.


| Symptom in `journalctl`                                                                           | Likely cause                                                                                                           | Fix                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Agreements watcher: disabled` on startup                                                         | One of `IMAP_USER`/`MN_EMAIL`, `IMAP_HOST`, `IMAP_PASSWORD` empty                                                      | Re-check `.env`, ensure no stray quotes/whitespace, restart                                                                            |
| `auth failed` / `LOGIN failed`                                                                    | App Password wrong, or generated under the alias instead of the real Gmail account                                     | Regenerate App Password under the *mailbox* account; set `IMAP_USER` to that mailbox                                                   |
| `ETIMEDOUT` / `ECONNREFUSED`                                                                      | Outbound 993 blocked, or wrong host/port                                                                               | `nc -vz imap.gmail.com 993` from the box; allow egress                                                                                 |
| Emails arrive in Gmail but no `[imap]` activity                                                   | `IMAP_MAILBOX` wrong, or a Gmail filter moves mail before the poller sees it                                           | Set `IMAP_MAILBOX=INBOX`; disable filters that "Skip the Inbox" for MN messages                                                        |
| `processed_emails` rows but no `agreements` rows                                                  | `articleId` parsed from URL doesn't match any entry in `AGREEMENT_ARTICLES` (still `TODO-article-`*, or wrong post ID) | Update `src/config/agreements.ts`, `npm run build`, restart                                                                            |
| `member ... reached required agreements - add-all-spaces enqueued` but member not added to spaces | Auto-add job failed silently                                                                                           | Look for `[auto-add]` errors in the journal right after that line; check Puppeteer login state with `npm run clean:profile` then retry |
| Service logged in as the wrong MN account                                                         | Stale Puppeteer profile (rare — safeguard usually catches this)                                                        | `sudo systemctl stop emergent-admin && sudo -u deploy npm run clean:profile && sudo systemctl start emergent-admin`                    |


For deeper investigation, the SQLite file is plain on disk and safe to
read while the service runs (WAL mode):

```bash
# Most-recent 20 emails the poller saw
sqlite3 /home/deploy/EmergentAdmin/data/ec-admin.db \
  "SELECT message_id, datetime(processed_at/1000,'unixepoch','localtime')
   FROM processed_emails ORDER BY processed_at DESC LIMIT 20;"

# Per-member agreement progress
sqlite3 /home/deploy/EmergentAdmin/data/ec-admin.db \
  "SELECT m.full_name, m.member_id, count(a.article_id) AS agreements,
          datetime(m.added_at/1000,'unixepoch','localtime') AS added
   FROM members m LEFT JOIN agreements a ON a.member_id = m.member_id
   GROUP BY m.member_id ORDER BY agreements DESC, m.full_name;"
```

## 6. Create systemd service

systemd does **not** source the user's shell, so `nvm` (a shell function) is not on `PATH` by default. We start Node through a short `bash -lc` wrapper that sources nvm and reads `.nvmrc`. This way the service always tracks whatever version the repo pins — no unit-file edits needed when you bump Node.

```bash
sudo tee /etc/systemd/system/emergent-admin.service > /dev/null <<'EOF'
[Unit]
Description=EmergentAdmin MN Host Automator
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/EmergentAdmin
Environment=NODE_ENV=production
Environment=NVM_DIR=/home/deploy/.nvm
ExecStart=/bin/bash -lc 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use --silent && exec node dist/server.js'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

> **Note:** Adjust `User`, `WorkingDirectory`, and the `NVM_DIR` path if you're not using the `deploy` user. The `exec` in `ExecStart` is important — it replaces the bash wrapper with the node process so systemd can track the real PID and forward signals correctly.
>
> **Alternative (pinned path):** If you'd rather not involve bash at all, run `which node` after `nvm use` and hard-code it:
>
> ```ini
> ExecStart=/home/deploy/.nvm/versions/node/v20.18.1/bin/node dist/server.js
> ```
>
> This is marginally faster to start but you'll need to update the unit file every time `.nvmrc` changes.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable emergent-admin
sudo systemctl start emergent-admin
sudo systemctl status emergent-admin
```

View logs:

```bash
sudo journalctl -u emergent-admin -f
```

## 7. nginx subdomain with WebSocket proxy

Create the site config:

```bash
sudo tee /etc/nginx/sites-available/emergent-admin > /dev/null <<'EOF'
upstream emergent_admin {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name admin.emergentcommons.app;

    location / {
        proxy_pass http://emergent_admin;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Long-running tasks need generous timeouts
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF
```

Enable the site and reload:

```bash
sudo ln -s /etc/nginx/sites-available/emergent-admin /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 8. SSL with Let's Encrypt

Since certbot is already installed:

```bash
sudo certbot --nginx -d admin.emergentcommons.app
```

Certbot will modify the nginx config to add SSL and redirect HTTP → HTTPS.

```

### WebSocket over HTTPS

After certbot rewrites the config, the `wss://` protocol is handled automatically — nginx terminates SSL and proxies to the Node.js app over plain HTTP/WS on localhost.

The frontend already uses `'ws://' + location.host` which will need to become `'wss://'` when served over HTTPS. Update `public/index.html`:

```js
// Change this:
ws = new WebSocket('ws://' + location.host);

// To this (auto-detects protocol):
ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
```

## 9. DNS

Add an A record for your subdomain pointing to the server's IP:

```
admin.emergentcommons.app.  A  <server-ip>
```

## 10. Deploying updates

From the server as the app user:

Create a one-liner deploy script.

`~/deploy-emergent-admin.sh`:

```bash
#!/bin/bash
set -e

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

cd ~/EmergentAdmin
git pull origin main

nvm install           # no-op if .nvmrc version already installed
nvm use

npm ci --production
npm run install:browsers
npm run build
sudo systemctl restart emergent-admin
echo "Deployed $(git log -1 --format='%h %s') on node $(node -v)"
```

```bash
chmod +x ~/deploy-emergent-admin.sh
```

> **Note:** The deploy user needs passwordless sudo for `systemctl restart emergent-admin`. Add to sudoers:
>
> ```
> deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart emergent-admin
> ```

---

## Troubleshooting

### Chrome fails to launch

```
Error: Failed to launch the browser process
```

Usually missing system libraries. Run:

```bash
ldd ~/.cache/puppeteer/chrome/*/chrome-linux64/chrome | grep "not found"
```

Install whatever is missing.

### Permission denied on .puppeteer-profile

The `PUPPETEER_USER_DATA_DIR` path is relative to `WorkingDirectory`. Make sure the app user owns it:

```bash
mkdir -p /home/deploy/EmergentAdmin/.puppeteer-profile
chown deploy:deploy /home/deploy/EmergentAdmin/.puppeteer-profile
```

### Account switch: "Already logged in" as the previous account

Symptom: you change `MN_EMAIL` / `MN_PASSWORD` in `.env`, restart the service, but the logs still show `Already logged in — skipping login.` and every task runs as the old account.

Cause: `PUPPETEER_USER_DATA_DIR` persists the old account's session cookie across restarts, so MN serves the signed-in shell and the login form is never rendered.

Fix: the server automatically wipes the profile when it detects `MN_EMAIL` has changed since the last successful login (it writes a `.account` marker inside the profile dir). If you ever need to force a reset manually:

```bash
systemctl stop emergent-admin
rm -rf /home/deploy/EmergentAdmin/.puppeteer-profile
systemctl start emergent-admin
```

The next run will execute the full login flow and rebuild the profile bound to the new account.

### Service starts with the wrong Node version

Symptom: `systemctl status emergent-admin` shows the service running, but it's using the system-wide Node (e.g. v24) instead of the version in `.nvmrc`, causing crashes or native-module errors.

Cause: systemd does not source your shell, so `nvm` isn't on `PATH` unless the unit explicitly loads it. If `ExecStart` points at `/usr/bin/node` or a bare `node`, you get whatever happens to be globally installed.

Fix: use the `bash -lc` wrapper from section 6, or hard-code the absolute path to the nvm-managed binary:

```bash
# As the deploy user:
cd ~/EmergentAdmin
nvm use
which node            # copy this path into ExecStart=
```

After editing the unit:

```bash
sudo systemctl daemon-reload
sudo systemctl restart emergent-admin
sudo journalctl -u emergent-admin -n 50 --no-pager
```

Confirm the right version is running:

```bash
sudo systemctl status emergent-admin   # note the PID
sudo readlink -f /proc/<PID>/exe        # should point into ~/.nvm/versions/node/...
```

### WebSocket disconnects immediately

Check that the nginx config has `proxy_set_header Upgrade` and `Connection "upgrade"`. Without these, nginx drops WebSocket connections.

### Admin run-log emails aren't arriving

The email hook is deliberately silent when disabled, so "nothing in the log"
doesn't tell you whether it tried and failed or never tried at all. Check the
gates in order:

1. `**NODE_ENV` must be `production`.** Confirm the unit is setting it:
  ```bash
   sudo systemctl show emergent-admin -p Environment
   # Should include: NODE_ENV=production
  ```
2. **All five `SMTP_`* vars must be set.** `dotenv` loads `.env` at process
  start, so a typo or missing var silently disables sending. Quick check:
   Restart the service after edits — `.env` is only read at startup.
3. **Look for a send failure.** If sending was attempted but rejected by the
  SMTP server, the journal will contain a line like:
   Common causes: Gmail without an App Password, SES sender not verified,
   firewall blocking outbound 587/465.
4. **Outbound SMTP blocked?** Many VPS providers block outbound SMTP by
  default. Verify connectivity from the server itself:
   If this hangs or is refused, you'll need to unblock the port with your
   provider or switch to a provider-scoped relay.
5. **Check spam.** First sends from a new sender domain often land in the
  spam folder — especially from a residential IP or un-SPF'd domain.

