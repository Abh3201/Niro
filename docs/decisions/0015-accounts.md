# 0015: Optional accounts (Google, emailed link) in the web app, on top of share links

- Status: accepted. Changes part of [0002](0002-sharing.md): Niro now has accounts, when they're set up.
- Date: 2026-10-29
- Code: [`apps/web/app/accounts/`](../../apps/web/app/accounts/) (`auth.server.ts`, `boards.server.ts`, `db.server.ts`, `email.server.ts`), [`apps/web/app/routes/boards.tsx`](../../apps/web/app/routes/boards.tsx), [`signin.tsx`](../../apps/web/app/routes/signin.tsx), [`api.token.ts`](../../apps/web/app/routes/api.token.ts), the erase route in [`apps/realtime/src/server.ts`](../../apps/realtime/src/server.ts)

## Context

0002 left accounts out of v0.1: whoever has a link has access, and a board lives in the browsers that opened it and on the server. People asked to sign in, find their boards from any device, and manage several boards: name them, delete them.

## Decision

- **Accounts are optional.** They're on when the web app has `DATABASE_URL` and a way to sign in (Google, or email). Otherwise nothing mentions signing in and Niro works exactly as 0002 describes. Signed out, `/` still makes a new board.
- **Better Auth 1.7, in the web app**, at `/api/auth/*`. Sign in with Google (OAuth) or a link emailed with Resend (one use, 10 minutes, stored hashed). No passwords. Sessions are rows in Postgres behind a cookie on the web app's own domain, for 30 days. Its signing secret is derived from `NIRO_SECRET` with a label, so there's no second secret.
- **The web app gets the database, not the realtime server the accounts.** The session cookie must be on the domain people visit (Vercel, say); the realtime server is often on another (`azurewebsites.net`), where it would be a third-party cookie, which browsers block. So the web app now reads and writes the same Postgres as the realtime server, in its own tables: Better Auth's, `board_info` (title, owner, deleted) and `board_members` (who opened what, with which access). Its migrations are separate (`niro_web_migrations`, a different advisory lock), and it never touches the realtime server's tables.
- **Links stay the way in; the account remembers.** Opening a board with a link while signed in puts it on your list with that link's access (the better one, if you had two). After that, the board opens for you without the link, on any device: `/api/token` accepts the session as well as a key, and answers with the key for your access, which the page puts in the address bar so Share still works.
- **Ownership.** A board made from My boards belongs to whoever made it. Boards made signed out, or before accounts, belong to nobody until an editor clicks "Save to my boards". Only the owner renames or deletes.
- **Deleting is for good.** The web app marks the board deleted, so no link opens it from then on (`/api/token` and the board page answer 410). The browser then hands the realtime server a 60-second erase token (signed with `NIRO_SECRET` under its own label, so it can't pass for an access token), and the server closes everyone's connection, drops the room without writing it, and deletes its updates, images and versions. For the next minute it also refuses access tokens issued before the erase. If the realtime server can't be reached, My boards tries again on the next visit. The `board_info` row stays as a tombstone, so an old link can never make the board again.

## Why

- **Better Auth over doing it by hand** (Arctic for OAuth plus React Router's cookie sessions). By hand teaches more, but is about 600 lines of security code to own: OAuth state and PKCE, token hashing, account linking, CSRF and rate limits. Better Auth is framework-free (a `Request` in, a `Response` out), runs on Postgres with the `pg` we already use, and is maintained. Auth.js and Lucia were the other candidates; Lucia is now a learning resource, not a library.
- **An emailed link, not passwords.** Nothing to leak, no reset flow, and email is needed for a reset anyway. Resend's free tier (3,000 emails a month, 100 a day) covers a personal deployment.
- **Membership needs a link first.** Accounts don't change who can see a board: only a key (or ownership) gives access. A list is a convenience, not a new kind of sharing, so 0002's reasoning still holds.

## What this gives up

- **No removing one person.** Someone who opened the edit link keeps edit access through their account, as they would through the link. Per-person sharing (invite by email, change or revoke a role) is the next step; it needs the members table this adds.
- **Two servers write one database.** Still one realtime server per database (0003); the web app's writes are small and its own tables.
- **Every token request reads the database** when accounts are on (the board's tombstone, the session, the membership): a few milliseconds each, more when a free Neon database wakes up.
- **Sign-in emails can be asked for any address.** Limited per IP (5 in 10 minutes, kept in Postgres since serverless hosts run many instances), but a determined abuser could still use up the email provider's daily quota.
- **Better Auth moves fast.** 1.7.7 fixed a critical magic-link account takeover. Keep it updated.
- **A deleted board stays in browsers that had it** (IndexedDB), read-only, until they clear it.
