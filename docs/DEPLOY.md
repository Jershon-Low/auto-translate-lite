# Deploying Auto Translate Lite

This guide walks through a test deployment on **AWS EC2**'s free tier, which comfortably covers the CPU/RAM needs of both apps for a short-lived test (with one caveat on RAM during the build — see Step 1). If you already have a VPS elsewhere, skip to Step 2 — everything from there on applies to any Ubuntu 22.04 host.

## 1. Provision a free-tier EC2 instance

1. **Sign up / use an existing AWS account** at https://aws.amazon.com. New accounts get 750 hours/month of `t2.micro`/`t3.micro` EC2 usage free for the first 12 months. Note this is different from Oracle's "Always Free" model — AWS's free tier expires after 12 months, it isn't a permanent free allowance, so don't leave the instance running indefinitely and forget about it.

2. **Launch the instance**: EC2 Console → **Instances** → **Launch instances**.
   - **Name**: anything, e.g. `auto-translate-lite`.
   - **AMI**: **Ubuntu Server 22.04 LTS** (free tier eligible, marked as such in the AMI picker).
   - **Instance type**: **t2.micro** or **t3.micro** (free tier eligible — 1 vCPU / 1 GB RAM).
     - 1 GB RAM is tight for building this project's Next.js frontend on-box — `npm run build` in `web/` can spike well past 1 GB and get OOM-killed. Pick one of two mitigations before you build in Step 3:
       - **(a) Add a 2 GB swap file** (recommended — simpler default for a one-off test deploy):
         ```bash
         sudo fallocate -l 2G /swapfile
         sudo chmod 600 /swapfile
         sudo mkswap /swapfile
         sudo swapon /swapfile
         echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
         ```
       - **(b) Build locally instead**: run `npm run build` for `web/` on your own machine, then `scp` the built `.next/`, `node_modules/`, and `package.json` up to the instance instead of running the build on-box.
   - **Key pair**: create a new key pair (type **RSA**, format **.pem**), download it, then lock down its permissions locally: `chmod 400 /path/to/key.pem`.
   - **Network settings**: click **Edit**. The default VPC's default subnet already auto-assigns a public IP — unlike some other clouds, this typically isn't a separate gotcha on EC2 — just confirm **Auto-assign public IP** is set to **Enable**.
   - **Firewall (security group)**: create a new security group with these inbound rules:
     | Type | Port | Source |
     |---|---|---|
     | SSH | 22 | My IP |
     | HTTP | 80 | Anywhere (0.0.0.0/0) |
     | HTTPS | 443 | Anywhere (0.0.0.0/0) |
     Keep SSH scoped to **My IP**, not `0.0.0.0/0` — there's no reason to leave SSH open to the whole internet.
   - Click **Launch instance**. Wait for the instance state to reach **Running** and status checks to show **2/2 status checks passed**, then note the public IPv4 address from the instance details page (e.g. `54.123.45.67`).
   - Note: standard Ubuntu EC2 AMIs do **not** ship with an additional OS-level firewall (no default iptables/ufw rules blocking incoming traffic) — the security group above is the only firewall layer that matters here.

3. **SSH in**: `ssh -i /path/to/key.pem ubuntu@<public-ip>` (Ubuntu AMIs use the `ubuntu` user by default).

4. **Get a hostname without buying a domain.** Since this is a test deployment, use a free wildcard-DNS service that resolves any hostname containing an IP straight to that IP — [sslip.io](https://sslip.io). Take the public IP and replace the dots with dashes, then append `.sslip.io`:

   > IP `54.123.45.67` → hostname `54-123-45-67.sslip.io`

   This resolves publicly with zero DNS setup, and works as a normal domain in the Caddyfile below — Caddy can still obtain a real Let's Encrypt certificate for it, so you get real HTTPS. Use `<public-ip-with-dashes>.sslip.io` in place of `translate.yourchurch.org` everywhere below. If you already own a real domain, point an A record at the public IP and use that domain instead — everything past this point works identically either way.

## 2. Install Node.js and pm2
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

## 3. Clone the repo and install dependencies
```bash
git clone <your-repo-url> auto-translate-lite
cd auto-translate-lite/server && npm install && npm run build
cd ../web && npm install && npm run build
```

## 4. Configure environment variables
- `server/.env`: `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `PORT=3001`.
- `web/.env.production`: `NEXT_PUBLIC_WS_URL=wss://54-123-45-67.sslip.io` (substitute your own instance's hostname — the sslip.io one from Step 1, or your real domain).

## 5. Install and configure Caddy as a reverse proxy (automatic HTTPS)
```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:
```
54-123-45-67.sslip.io {
  reverse_proxy /ws/* localhost:3001
  reverse_proxy /health localhost:3001
  reverse_proxy /sermon-doc localhost:3001
  reverse_proxy /feedback localhost:3001
  reverse_proxy /viewer-feedback* localhost:3001
  reverse_proxy localhost:3000
}
```

Every REST endpoint the backend exposes needs its own line here (in addition to `/ws/*`) — anything not explicitly matched falls through to the frontend on `localhost:3000` and 404s, since Next.js has no route for it. If you add a new backend route in `server/src/app.ts`, add a matching `reverse_proxy` line here too.

```bash
sudo systemctl reload caddy
```

## 6. Start both apps with pm2

`ecosystem.config.js` (at repo root — see below).

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 7. Verify

```bash
curl http://localhost:3001/health
```
Expected: `{"status":"ok"}`

Open `https://54-123-45-67.sslip.io` on a phone.
Expected: the language picker loads over HTTPS; devtools Network tab shows a `101 Switching Protocols` response when a language is selected (WSS upgrade succeeded).

## 8. Generate the QR code for the LED wall
Point any QR code generator (e.g. `qrencode "https://54-123-45-67.sslip.io" -o qr.png`, or an online generator) at `https://54-123-45-67.sslip.io` and display the result on the LED wall.
