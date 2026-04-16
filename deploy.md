# Deploying EmergentAdmin on Debian 11 (Bullseye)

This guide assumes:
- Debian 11 (bullseye) server with root/sudo access
- nginx already installed and serving other sites
- Git SSH access to `git@github.com:KevinTriplett/EmergentAdmin.git`

---

## 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node -v   # should print v20.x
npm -v
```

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

```bash
sudo tee /etc/systemd/system/emergent-admin.service > /dev/null <<'EOF'
[Unit]
Description=EmergentAdmin MN Host Automator
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/EmergentAdmin
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

> **Note:** Adjust `User` and `WorkingDirectory` if you're not using the `deploy` user.

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
cd ~/EmergentAdmin
git pull origin main
npm ci --production
npm run build
sudo systemctl restart emergent-admin
echo "Deployed $(git log -1 --format='%h %s')"
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

### WebSocket disconnects immediately

Check that the nginx config has `proxy_set_header Upgrade` and `Connection "upgrade"`. Without these, nginx drops WebSocket connections.
