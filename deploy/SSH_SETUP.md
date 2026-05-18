# Deployment Setup

This guide walks you through configuring GitHub Actions to build the Docker image, push it to GHCR, and roll it out on your Proxmox Docker host via a Cloudflare Access SSH proxy.

The workflow at `.github/workflows/deploy.yml`:
1. Builds `ghcr.io/iheidari/yt-downloader:latest` and `:<sha>`.
2. SSHes to your host through `cloudflared access` (no public SSH port required).
3. Runs `docker compose pull && docker compose up -d` in `/opt/yt-downloader`.

---

## 1. Generate an SSH key pair for CI

On your local machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github-actions-deploy
# Press Enter for an empty passphrase
```

Add the **public** key to your server:

```bash
cat ~/.ssh/github-actions-deploy.pub \
  | ssh user@your-server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

---

## 2. Create a Cloudflare Access service token

GitHub Actions reaches your server through a Cloudflare-protected SSH hostname. You need a service token so the runner can satisfy the Access policy.

1. Cloudflare Zero Trust → **Access → Service Auth → Service Tokens** → **Create Service Token**.
2. Copy the **Client ID** and **Client Secret** (the secret is shown once).
3. In the Access application protecting your SSH hostname, add a policy that includes this service token.

---

## 3. Create a GHCR pull token

The host pulls the image from GitHub Container Registry, so it needs a Personal Access Token with `read:packages`.

1. GitHub → **Settings → Developer settings → Personal access tokens (classic)** → **Generate new token**.
2. Scope: `read:packages`.
3. Save the token — you'll add it as `GHCR_READ_TOKEN` below.

---

## 4. Add GitHub repository secrets

Go to `https://github.com/iheidari/yt-downloader` → **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
| --- | --- |
| `SSH_PRIVATE_KEY` | Full contents of `~/.ssh/github-actions-deploy` (including BEGIN/END lines) |
| `SERVER_HOST` | SSH hostname protected by Cloudflare Access (e.g. `ssh.heidari.ca`) |
| `SERVER_USER` | SSH username on the Docker host |
| `SERVER_SSH_PORT` | SSH port on the host (e.g. `22`) |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token Client ID |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token Client Secret |
| `GHCR_READ_TOKEN` | GitHub PAT with `read:packages` |

---

## 5. Prepare the Docker host

One-time setup on the Proxmox Docker host:

```bash
sudo mkdir -p /opt/yt-downloader/downloads
sudo chown -R "$USER:$USER" /opt/yt-downloader
cd /opt/yt-downloader

# Copy docker-compose.yml from the repo
scp /path/to/repo/docker-compose.yml user@host:/opt/yt-downloader/

# Create .env on the host
cat > /opt/yt-downloader/.env <<'EOF'
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://ytd.heidari.ca
EOF

# Log in to GHCR once so the first pull works
echo "<GHCR_READ_TOKEN>" | docker login ghcr.io -u iheidari --password-stdin
```

---

## 6. Publish the app via Cloudflare Tunnel

There is no Caddy and no host-exposed port required — Cloudflare Tunnel terminates TLS and routes the public hostname directly to the container.

In Cloudflare Zero Trust → **Networks → Tunnels → your tunnel → Public Hostname**, add:

- **Subdomain**: `ytd`
- **Domain**: `heidari.ca`
- **Service**: `http://localhost:3001` (or `http://yt-downloader:3001` if `cloudflared` runs in the same Docker network)

---

## 7. Test the path manually

From your local machine, confirm the Cloudflare Access SSH proxy works before relying on Actions:

```bash
cloudflared access ssh \
  --hostname ssh.heidari.ca \
  --service-token-id "$CF_ACCESS_CLIENT_ID" \
  --service-token-secret "$CF_ACCESS_CLIENT_SECRET" \
  -- -i ~/.ssh/github-actions-deploy -p 22 user@ssh.heidari.ca
```

You should land on the host with no password prompt.

---

## 8. Deploy

```bash
git push origin main
```

The `Build & Deploy` workflow builds the image, pushes to GHCR, and rolls the container on the host.

---

## Troubleshooting

**`denied: permission_denied` when pushing to GHCR**
The build job needs `packages: write` (already set in the workflow) and the repo must allow GitHub Actions to write packages: Settings → Actions → General → Workflow permissions → "Read and write permissions".

**`unauthorized` when the host pulls the image**
`GHCR_READ_TOKEN` is missing or lacks `read:packages`. Re-run `docker login ghcr.io` on the host with a valid PAT.

**`cloudflared access ssh` hangs or returns 403**
The service token isn't included in the Access policy for that hostname, or the token client ID/secret are wrong.

**Container is up but `ytd.heidari.ca` returns 502**
The Cloudflare Tunnel public hostname isn't pointing at `http://localhost:3001` (or the right Docker network name).

**Inspect on the host**
```bash
cd /opt/yt-downloader
docker compose ps
docker compose logs -f app
```

---

## Checklist

- [ ] Generated `~/.ssh/github-actions-deploy` and installed the public key on the host
- [ ] Created a Cloudflare Access service token and added it to the SSH hostname policy
- [ ] Created a GHCR PAT with `read:packages`
- [ ] Added all seven secrets to the GitHub repo
- [ ] Prepared `/opt/yt-downloader` with `docker-compose.yml` and `.env`
- [ ] Configured a Cloudflare Tunnel public hostname for `ytd.heidari.ca`
- [ ] Verified `cloudflared access ssh` works locally
- [ ] Pushed to `main` and confirmed the workflow succeeded
