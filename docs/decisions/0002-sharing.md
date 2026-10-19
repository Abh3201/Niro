# 0002: Share links are capability keys; the WebSocket takes a 60-second token

- Status: accepted
- Date: 2026-10-17
- Code: [`packages/sync/src/auth.ts`](../../packages/sync/src/auth.ts), [`apps/web/app/routes/api.token.ts`](../../apps/web/app/routes/api.token.ts), the upgrade check in [`apps/realtime/src/server.ts`](../../apps/realtime/src/server.ts)

## Decision

Niro v0.1 has no accounts. Whoever has a board's link has access, and the link says which kind:

- `/b/<id>#k=e.<22 chars>` lets you edit.
- `/b/<id>#k=v.<22 chars>` lets you view.

The 22 characters are an HMAC-SHA256 of the board id and the role under `NIRO_SECRET`, cut to 132 bits. So:

- **Nothing is stored.** Any server with the secret can check any key. There is no sharing table to migrate, back up or keep in sync between the two servers.
- **Keys can't be guessed or made up.** Making one needs the secret; guessing one means guessing 132 random bits.
- **The key never reaches a server log.** It sits in the URL fragment, which browsers never send in requests or in `Referer` headers. The page reads it with JavaScript and POSTs it to `/api/token`.

`/api/token` answers with a token that lasts 60 seconds: the board id, the role and the expiry, signed with the same secret. The browser opens the WebSocket with that token in the query string. The realtime server checks it before accepting the upgrade, so a refused connection costs one HTTP response. Query strings do get logged by proxies and servers, which is why the long-lived key never goes there; a token in a log is useless a minute later. Each reconnect fetches a new one.

Editors also get the view key from `/api/token`, so they can hand out a view-only link.

## What the server enforces

- **Viewers can't change the board.** The room drops every document update from a view-only connection (`Room.stats.updatesRefused` counts them). The view-only store in the browser also ignores edits, but that's for the interface; the server is what stops a modified client.
- **A token is for one board.** A valid token for board A doesn't open board B.
- **Presence is not authenticated.** A connection speaks for one awareness client id, the first it names, and its state is capped at 16 KB. Anyone with a link could claim another person's name or color, as they could edit the board. That's acceptable without accounts.

## What this gives up

- **No revoking one link.** A leaked edit link works until `NIRO_SECRET` changes, which changes every link to every board. Per-board revocation needs a stored key version per board; that arrives with persistence (P3b) if it's wanted.
- **No identity.** Names are whatever people type. Accounts are a non-goal for v0.1.
- **The secret is a single point of failure.** It's required in production (`readSecret` refuses to start without 32+ characters) and only the two servers hold it. The development fallback is public, and is used only when `NODE_ENV` isn't `production`.

## Alternatives considered

- **Random keys stored per board.** Allows revocation, but needs a database before there is one (P3b), and both servers would have to read it.
- **The key in the WebSocket URL directly.** Simpler, but puts a permanent credential into every proxy log.
- **The key in a cookie.** Links would stop carrying access by themselves, and sharing a board is the point of the link.
