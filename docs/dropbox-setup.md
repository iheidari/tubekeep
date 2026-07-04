# Dropbox App Setup — obtaining the credentials

How to create the Dropbox app and get the values for the env vars used by the
"Move to Dropbox" feature (`DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`,
`DROPBOX_REDIRECT_URI`, `VITE_DROPBOX_APP_KEY`, `VITE_DROPBOX_REDIRECT_URI`).

See **[cloud-upload-design.md](./cloud-upload-design.md)** for the overall design.

---

## 1. Create the app

1. Go to the **Dropbox App Console**: https://www.dropbox.com/developers/apps
2. Click **Create app**.
3. **Choose an API:** *Scoped access* (the only option).
4. **Choose the type of access you need:** select **App folder**.
   - This is deliberate and effectively permanent. The app can only read/write a single
     dedicated folder Dropbox creates at `/Apps/<YourAppName>/`. It cannot see anything else
     in the user's Dropbox — the tightest blast radius and easiest to get approved.
   - Do **not** pick "Full Dropbox" — we don't need it and it broadens scope/approval.
5. **Name your app** (e.g. `Tubekeep`). This name becomes the folder name under `/Apps/`.

## 2. Get the key and secret

On the app's **Settings** tab:
- **App key** → this is `DROPBOX_APP_KEY` (backend) **and** `VITE_DROPBOX_APP_KEY` (frontend).
  The app key is public/not secret; it's safe in the browser.
- **App secret** → click **Show** → this is `DROPBOX_APP_SECRET` (**backend only**, never ship
  to the browser).

## 3. Configure OAuth redirect URIs

Still on **Settings**, find **OAuth 2 → Redirect URIs** and add **exact-match** URLs:
- Production: `https://<your-host>/oauth/callback`
- Local dev: `http://localhost:5173/oauth/callback`

Whatever you register here must match `DROPBOX_REDIRECT_URI` / `VITE_DROPBOX_REDIRECT_URI`
exactly (scheme, host, port, path). Dropbox rejects mismatches.

> We use **PKCE** from the browser popup and a stateless backend relay for the code/refresh
> exchange, so the secret stays on the server.

## 4. Set permissions (scopes)

On the **Permissions** tab, enable exactly:
- **`files.content.write`** — upload files to the app folder.
- **`account_info.read`** — read basic account info (to show "Connected as user@email").

Enable nothing else. Click **Submit** to save the scope selection.

> If you change scopes after users have already authorized, they must re-consent.

## 5. Token settings

- Ensure the app issues **refresh tokens** (offline access). With PKCE we request
  `token_access_type=offline` so the browser receives a refresh token to mint new access tokens.
- Dropbox short-lived **access tokens last ~4 hours**; the refresh token is long-lived and held
  only in the visitor's browser `sessionStorage`.

## 6. Development vs Production

- New apps start in **Development** mode: usable by the app owner and a small number of linked
  accounts (fine for building/testing).
- To let arbitrary visitors connect, click **Enable additional users** and eventually **Apply
  for production** on the app console. App-folder apps with minimal scopes get a lightweight
  review.

---

## Where each value goes

| Console value | Env var | Side | Secret? |
|---|---|---|---|
| App key   | `DROPBOX_APP_KEY` + `VITE_DROPBOX_APP_KEY` | backend + frontend | No |
| App secret| `DROPBOX_APP_SECRET` | backend only | **Yes** |
| Redirect URI | `DROPBOX_REDIRECT_URI` + `VITE_DROPBOX_REDIRECT_URI` | backend + frontend | No |

```
# backend/.env
DROPBOX_APP_KEY=your_app_key
DROPBOX_APP_SECRET=your_app_secret
DROPBOX_REDIRECT_URI=https://<your-host>/oauth/callback

# frontend/.env
VITE_DROPBOX_APP_KEY=your_app_key
VITE_DROPBOX_REDIRECT_URI=https://<your-host>/oauth/callback
```

Never commit `.env` or the app secret. The secret must exist only on the backend.
