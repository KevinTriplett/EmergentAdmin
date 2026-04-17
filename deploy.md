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

Edit `.env` with your MN credentials:

```
MN_EMAIL=your@email.com
MN_PASSWORD=yourpassword
PUPPETEER_USER_DATA_DIR=.puppeteer-profile
PORT=3000
```

Verify it starts:

```bash
npm start
# Should print: MN Host Automator listening on http://localhost:3000
# Ctrl-C to stop
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
> ```ini
> ExecStart=/home/deploy/.nvm/versions/node/v20.18.1/bin/node dist/server.js
> ```
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
