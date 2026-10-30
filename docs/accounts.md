# Accounts: sign in with Google or by email

Signing in is optional. With it, people get **My boards**: every board they made or opened while signed in, on any device, where they can make, rename, delete and open boards. Share links work as before, signed in or not. Why it's built this way: [decision 0015](decisions/0015-accounts.md).

Accounts are on when the **web app** has both:

1. `DATABASE_URL`: the same Postgres the realtime server uses. On Neon, use the **pooled** connection string (its host has `-pooler` in it).
2. At least one way to sign in: Google, email, or both (below).

It also needs `PUBLIC_URL`, the address people open Niro at, like `https://board.example.com` (no trailing `/`). Google sends people back there after signing in, and email links point there. In production, accounts stay off without it (the web app's log says so).

The realtime server needs nothing new.

| Setting (web app) | Value |
|---|---|
| `DATABASE_URL` | Postgres connection string; on Neon, the pooled one |
| `PUBLIC_URL` | `https://<your domain>` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google (below) |
| `RESEND_API_KEY` | from Resend (below) |
| `EMAIL_FROM` | `Niro <signin@your-domain>`, on a domain verified in Resend |
| `NIRO_DB_POOL` | optional: database connections per web app instance, default 5 |
| `NIRO_OPERATOR` | who runs the site, shown in the privacy policy and terms, like `Ada Lovelace` |
| `NIRO_CONTACT_EMAIL` | where people send privacy and account-deletion requests |

In Docker compose, put these in `.env` ([`.env.example`](../.env.example) lists them); `DATABASE_URL` is set for you, and `compose.https.yml` sets `PUBLIC_URL` from `NIRO_DOMAIN`. On Vercel and Azure, add them where `NIRO_SECRET` is: Vercel's **Environment Variables** ([deploy-vercel.md](deploy-vercel.md)), or the web app's **Environment variables** in Azure ([deploy-azure.md](deploy-azure.md)). Redeploy (or restart) after adding them.

The web app makes its tables on its first request: Better Auth's (`user`, `session`, `account`, `verification`, `rateLimit`) and its own (`board_info`, `board_members`). Back them up with the rest of the database ([self-hosting.md](self-hosting.md)).

## Google

About ten minutes, free.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and make a project (top bar, project picker, **New project**), for example "Niro".
2. Search for **Google Auth Platform** (it's also under **APIs & Services**, **OAuth consent screen**) and click **Get started**:
   - **App information**: app name `Niro`, your email as support email.
   - **Audience**: **External**.
   - **Contact information**: your email. Accept the policy, **Create**.
3. **Branding**: Google wants these pages on your own domain, which Niro serves for you (set `NIRO_OPERATOR` and `NIRO_CONTACT_EMAIL` first, so the policy names you and says how to reach you):
   - **Application home page**: `https://<your domain>/about` (`/` starts a new board, so it can't be the home page).
   - **Application privacy policy link**: `https://<your domain>/privacy`
   - **Application terms of service link**: `https://<your domain>/terms`
   - **Authorized domains**: your domain's top private domain: for `board.example.com`, `example.com`. Prove you own it in [Google Search Console](https://search.google.com/search-console) with the same Google account. A `*.vercel.app` or `*.azurewebsites.net` address can't be verified this way.
4. **Audience**, **Publish app**. Niro asks only for name, email and picture (`openid`, `email`, `profile`), which aren't sensitive scopes, so Google doesn't review the app. Until it's published, only the test users you add there can sign in. To show Niro's name and logo on Google's sign-in screen, also submit for brand verification (**Branding**, **Verify branding**; usually minutes, sometimes 2 to 3 business days).
5. **Clients**, **Create client**:
   - **Application type**: Web application. **Name**: Niro.
   - **Authorized redirect URIs**: `https://<your domain>/api/auth/callback/google`. Add `http://localhost:5173/api/auth/callback/google` too to try it with `pnpm dev`. It must match exactly: `http` or `https`, port, no trailing `/`.
   - **Create**. Copy the **Client ID** and **Client secret** now: Google shows the secret only once.
6. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the web app.

If you move to another domain, add its redirect URI to the client first.

## Email

Niro emails a link that signs you in once, within 10 minutes. It sends with [Resend](https://resend.com): the free plan sends 3,000 emails a month, at most 100 a day, from one domain.

1. Sign up at [resend.com](https://resend.com), **API Keys**, **Create API key** with **Sending access**. Set it as `RESEND_API_KEY`.
2. **Domains**, **Add domain**: your domain (or a subdomain, like `mail.example.com`). Add the DNS records Resend shows at your DNS provider and wait for **Verified**. Until then, Resend only delivers to your own Resend address ([Resend's note](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)).
3. Set `EMAIL_FROM` to an address on that domain, like `Niro <signin@example.com>`. The mailbox needn't exist.

Each IP address can ask for 5 links in 10 minutes.

In development (`pnpm dev`, so `NODE_ENV` isn't `production`) with no Resend key, the link is printed in the web app's log instead, so email sign-in works with only a local database:

```sh
docker run -d -p 5433:5432 -e POSTGRES_USER=niro -e POSTGRES_PASSWORD=niro postgres:18-alpine
DATABASE_URL=postgres://niro:niro@localhost:5433/niro pnpm dev
```

## Privacy policy and terms

`/privacy` and `/terms` describe what Niro stores and the rules for using it; `/about` describes Niro, and the sign-in page and My boards link all three. They name the site's operator and contact from `NIRO_OPERATOR` and `NIRO_CONTACT_EMAIL`, and only mention Google or email sign-in when it's set up. The list of hosting providers (Vercel, Azure, Neon, Resend) is the project's own deployment: if you host Niro elsewhere, edit "Who handles it" in [`apps/web/app/routes/privacy.tsx`](../apps/web/app/routes/privacy.tsx). Change a page's `UPDATED` date whenever you change it.

## What people see

- **Signed out**: a **Sign in** button next to Share on every board. `/` makes a new board, as before.
- **Signed in**: `/` goes to My boards. Boards you own come first; boards others shared with you (opened with their link while signed in) are under **Shared with me**, with the access the link gave. The first time, My boards offers to add the boards this browser opened before.
- **On a board**: its name next to the connection status; the owner clicks it to rename. Your account picture or initial opens a menu: My boards, Sign out, and **Save to my boards** for a board nobody owns yet (made signed out, or before accounts).
- **Deleting a board** (its owner, from My boards) stops every link to it working at once, and erases its content, images and versions from the realtime server. It can't be undone.

## Troubleshooting

| You see | Likely cause |
|---|---|
| No Sign in button | `DATABASE_URL` isn't set on the web app, or neither Google nor email is. Redeploy after setting them. |
| No Sign in button, and the log says `Accounts are off: set PUBLIC_URL` | Set `PUBLIC_URL` on the web app. |
| Google says `redirect_uri_mismatch` | The client's redirect URI isn't exactly `<PUBLIC_URL>/api/auth/callback/google`. |
| Google says `access_denied` / "app is being tested" | Publish the app (step 3), or add the account as a test user. |
| "The email couldn't be sent" | The web app's log has Resend's reason: usually an unverified domain, or the day's 100 emails are used. |
| A deleted board's content, images or versions are still in the database | The realtime server was asleep or unreachable when it was deleted; the owner's next visit to My boards tries again. |
