# Deployment Guide

This document records the current AWS EC2 deployment pattern used for this repo.

## Goal

Expose the local app running on port `3333` through a stable HTTPS callback URL suitable for OIDC redirect registration.

Current public URL:

```text
https://labai.54-175-248-13.sslip.io
```

Current callback URL:

```text
https://labai.54-175-248-13.sslip.io/callback
```

## Architecture

- Node app listens on `127.0.0.1:3333`
- Caddy terminates HTTPS on ports `80` and `443`
- Caddy reverse proxies to the local Node app
- `sslip.io` provides a stable hostname derived from the EC2 public IP
- `systemd` keeps both the app and reverse proxy running across logout and reboot

## Prerequisites

- Ubuntu EC2 instance
- Public IP reachable from the internet
- Security group allows inbound TCP `80` and `443`
- Node.js and npm installed
- Repo cloned locally with `.env` populated

## Application Configuration

Set the callback URL in `.env`:

```env
CALLBACK_URL=https://labai.54-175-248-13.sslip.io/callback
PORT=3333
```

The IdP should use:

```text
Redirect URI:      https://labai.54-175-248-13.sslip.io/callback
Post-Logout URI:   https://labai.54-175-248-13.sslip.io/
```

## Caddy Configuration

Install Caddy:

```bash
sudo apt-get update
sudo apt-get install -y caddy
```

Set `/etc/caddy/Caddyfile` to:

```caddy
labai.54-175-248-13.sslip.io {
    reverse_proxy 127.0.0.1:3333
}
```

Validate and restart:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy.service
sudo systemctl enable caddy.service
```

## App Service

Create `/etc/systemd/system/okta-xaa-app.service`:

```ini
[Unit]
Description=OKTA XAA MCP client example app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Repos/okta-xaa-dev-mcp-client-example
ExecStart=/usr/bin/npm run dev
Restart=always
RestartSec=5
Environment=HOME=/home/ubuntu
Environment=NODE_ENV=development

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable okta-xaa-app.service
sudo systemctl start okta-xaa-app.service
```

## Verification

Check the services:

```bash
sudo systemctl status okta-xaa-app caddy --no-pager
```

Check the public endpoint:

```bash
curl -I https://labai.54-175-248-13.sslip.io
```

Check recent Caddy logs:

```bash
sudo journalctl -u caddy.service -n 50 --no-pager
```

## Notes

- If the EC2 public IP changes, the `sslip.io` hostname must change with it.
- If the hostname changes, update both `.env` and the IdP redirect registrations.
- Caddy obtains and renews the TLS certificate automatically as long as ports `80` and `443` remain reachable.
- This setup replaces the earlier `ngrok`-based callback flow.
