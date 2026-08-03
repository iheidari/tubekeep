# OneDrive App Setup — obtaining the credentials

How to create the Microsoft Entra (Azure AD) app registration and get the values for the env
vars used by the "Move to cloud → OneDrive" feature (`MS_CLIENT_ID`, `MS_REDIRECT_URI`,
`VITE_MS_CLIENT_ID`, `VITE_MS_REDIRECT_URI`).

See **[cloud-upload-design.md](./cloud-upload-design.md)** for the overall design, and
**[dropbox-setup.md](./dropbox-setup.md)** / **[google-drive-setup.md](./google-drive-setup.md)**
for the equivalent setup for the other providers — all three share the same PKCE-popup +
backend-relay flow and the same `/oauth/callback` redirect route.

**Unlike Dropbox and Google Drive, OneDrive needs no client secret.** The app registration is a
**public client**, so there is nothing confidential to configure beyond the client id + redirect
URI — `MS_CLIENT_ID`/`MS_REDIRECT_URI` are the only two backend env vars this provider needs.

---

## 1. Create the app registration

1. Go to the **Azure Portal**: https://portal.azure.com/ → **Microsoft Entra ID** → **App
   registrations** → **New registration**.
2. **Name:** e.g. `Tubekeep`.
3. **Supported account types:** select **Accounts in any organizational directory and personal
   Microsoft accounts** (this is what maps to the `common` authority — both work/school (Entra
   ID) and personal (MSA, e.g. outlook.com/hotmail.com) accounts can connect).
4. **Redirect URI:** leave blank here — add it under Authentication (§3), where the platform
   type matters.
5. Click **Register**.

## 2. Make it a public client (no secret)

Under **Certificates & secrets**, do **not** create a client secret — this app never uses one.
Under **Authentication**, scroll to **Advanced settings** and set **Allow public client flows**
to **Yes**. This is what lets the PKCE authorization-code exchange succeed with no secret.

## 3. Configure the redirect URI

Still under **Authentication → Add a platform**, choose **Single-page application (SPA)** (not
"Web") — the app completes the exchange from a browser popup, so Graph's SPA platform type is
the correct one for PKCE. Add exact-match redirect URIs:

```
https://tubekeep.app/oauth/callback
https://ytd.heidari.ca/oauth/callback
http://localhost:5173/oauth/callback
```

Whatever you register here must match `MS_REDIRECT_URI` / `VITE_MS_REDIRECT_URI` exactly
(scheme, host, port, path). Microsoft rejects any mismatch with `redirect_uri_mismatch`.

## 4. Add the API permission

Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add:

- **`Files.ReadWrite.AppFolder`** — read/write only the app's own special folder
  (`/me/drive/special/approot`), never the rest of the user's OneDrive. This is the
  minimal-consent choice (mirrors Dropbox's app-folder model and Google Drive's `drive.file`
  scope) and does not require admin consent for work/school tenants.

Remove the default `User.Read` permission if you don't need it elsewhere — it isn't used here.

## 5. Get the client ID

On the app's **Overview** page:
- **Application (client) ID** → this is `MS_CLIENT_ID` (backend) **and** `VITE_MS_CLIENT_ID`
  (frontend). It's public, not secret — safe in the browser, same as the Dropbox app key /
  Google client ID.

There is no secret to copy — this app is a public client (§2).

## 6. Testing vs Production

Personal Microsoft accounts and any work/school tenant with **user consent for delegated
permissions** enabled can connect immediately — there's no "publish"/verification step to wait
on, since `Files.ReadWrite.AppFolder` is a low-privilege delegated scope. Some tenants disable
user consent for third-party apps entirely; in that case a work/school user needs their admin to
grant consent (or connecting a personal Microsoft account instead works with no such gate).

---

## Where each value goes

| Portal value | Env var | Side | Secret? |
|---|---|---|---|
| Application (client) ID | `MS_CLIENT_ID` + `VITE_MS_CLIENT_ID` | backend + frontend | No |
| Redirect URI | `MS_REDIRECT_URI` + `VITE_MS_REDIRECT_URI` | backend + frontend | No |

```
# backend/.env
MS_CLIENT_ID=your_application_client_id
MS_REDIRECT_URI=https://<your-host>/oauth/callback

# frontend/.env (only to OVERRIDE the values the backend already publishes)
VITE_MS_CLIENT_ID=your_application_client_id
VITE_MS_REDIRECT_URI=https://<your-host>/oauth/callback
```

Never commit `.env`. There's no secret to protect here, but the client ID + redirect URI still
belong only in the untracked `.env` files, matching the other providers.
