# Deploying Auto Translate Lite

This guide walks through a test deployment on Oracle Cloud Infrastructure's (OCI) **Always Free** tier, which comfortably covers the CPU/RAM needs of both apps at no cost. If you already have a VPS elsewhere, skip to Step 2 — everything from there on applies to any Ubuntu 22.04 host.

## 1. Provision a free VM on Oracle Cloud

1. **Sign up** at https://cloud.oracle.com for an Oracle Cloud Free Tier account. Oracle requires a credit card for identity verification, but Always Free resources are never charged.

2. **Create the VM instance**: Console → **Compute** → **Instances** → **Create Instance**.
   - **Image**: pick an Always-Free-eligible image, e.g. "Canonical Ubuntu 22.04" (Minimal or standard).
   - **Shape**: click **Change shape** → **Ampere** → **VM.Standard.A1.Flex** (Always Free eligible, ARM64). Configure it with **4 OCPUs / 24 GB RAM** — that's the full Always Free allowance for this shape family, and it's plenty to run both the Node backend and the Next.js frontend on one box.
     - Note: this is an **ARM64 (aarch64)** instance, not the x86 most tutorials assume. Node.js 20+ and every npm dependency this project uses (Express, ws, Next.js, etc.) support ARM64 natively, so this isn't a blocker — just don't be surprised when `uname -m` says `aarch64` instead of `x86_64`.
     - Fallback if ARM ever causes a problem: the **VM.Standard.E2.1.Micro** shape (AMD/x86, Always Free) is available too, but it's much tighter — only 1 GB RAM and 1/8 OCPU per instance (up to 2 instances). Use it only as a fallback; the walkthrough below assumes the A1.Flex shape.
   - **Networking**: keep the default VCN/subnet, and make sure **"Assign a public IPv4 address"** is checked.
   - **SSH keys**: let Oracle generate a key pair and download the private key (e.g. `ssh-key-2026-07-13.key`), or paste your own public key if you already have one.
   - Click **Create**. Wait for the instance to reach the **Running** state, then note its public IP address (e.g. `140.238.12.34`).

3. **Open the required ports.** This needs changes in **two separate places** — missing the second one is the most common thing people get stuck on:
   - **Oracle's Security List** (network-level firewall): Console → **Networking** → **Virtual Cloud Networks** → (your VCN) → **Security Lists** → (the default security list) → **Add Ingress Rules**. Add rules for source `0.0.0.0/0`, destination ports **80** (HTTP) and **443** (HTTPS). These are the only ports that need to be public — Caddy reverse-proxies everything, including the WebSocket paths, through 443.
   - **The instance's own OS firewall**: Oracle's Ubuntu images ship with `iptables` rules that block incoming traffic by default, independently of the Security List above. SSH in first (next step), then run:
     ```bash
     sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
     If `netfilter-persistent` isn't installed: `sudo apt install -y iptables-persistent` first (accept saving the current rules when prompted), then re-run the save command above.

4. **SSH in**: `ssh -i /path/to/downloaded-key.key ubuntu@<public-ip>` (Oracle's Ubuntu images use the `ubuntu` user by default).

5. **Get a hostname without buying a domain.** Since this is a test deployment, use a free wildcard-DNS service that resolves any hostname containing an IP straight to that IP — [sslip.io](https://sslip.io). Take the public IP and replace the dots with dashes, then append `.sslip.io`:

   > IP `140.238.12.34` → hostname `140-238-12-34.sslip.io`

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
- `web/.env.production`: `NEXT_PUBLIC_WS_URL=wss://140-238-12-34.sslip.io` (substitute your own instance's hostname — the sslip.io one from Step 1, or your real domain).

## 5. Install and configure Caddy as a reverse proxy (automatic HTTPS)
```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:
```
140-238-12-34.sslip.io {
  reverse_proxy /ws/* localhost:3001
  reverse_proxy localhost:3000
}
```

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

Open `https://140-238-12-34.sslip.io` on a phone.
Expected: the language picker loads over HTTPS; devtools Network tab shows a `101 Switching Protocols` response when a language is selected (WSS upgrade succeeded).

## 8. Generate the QR code for the LED wall
Point any QR code generator (e.g. `qrencode "https://140-238-12-34.sslip.io" -o qr.png`, or an online generator) at `https://140-238-12-34.sslip.io` and display the result on the LED wall.
