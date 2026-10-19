# 0008: Images are files the realtime server keeps per board; reactions are one key per person in the shape

- Status: accepted
- Date: 2026-10-19
- Code: [`apps/realtime/src/assets.ts`](../../apps/realtime/src/assets.ts), the `/assets/` routes in [`apps/realtime/src/server.ts`](../../apps/realtime/src/server.ts), [`apps/web/app/board/assets.ts`](../../apps/web/app/board/assets.ts), [`packages/engine/src/images.ts`](../../packages/engine/src/images.ts), [`packages/engine/src/reactions.ts`](../../packages/engine/src/reactions.ts), `readReactions` in [`packages/doc/src/shape.ts`](../../packages/doc/src/shape.ts)

## Images

- **The board holds only an id.** An image shape stores `asset`: the SHA-256 of the file, in hex. The bytes never enter the Yjs document. A board is capped at 5 MB and every byte of it is held in server memory about 25 times over ([0003](0003-storage.md)), viewers' messages are capped at 1 MB, and a CRDT never forgets: a deleted image would stay in the document's history for good.
- **The realtime server keeps the files,** in a `board_assets (board_id, id, type, data)` table in the same Postgres (in memory without `DATABASE_URL`). It already owns the database, its migrations and the limits; a second service, or the web app talking to Postgres, would be a second owner of both. Routes: `POST /assets/<board>` with the image as the body answers `{id}`; `GET /assets/<board>/<id>` returns it.
- **Access is the board's.** Both routes take the same 60-second token as the WebSocket, in an `Authorization` header: an edit token to upload, any token for that board to load. Images are scoped to a board, so knowing an image's hash gets nothing from another board. Because the token is a header and never a cookie, the routes answer `Access-Control-Allow-Origin: *`: the web app and the realtime server are on different ports by default, and another site calling them gains nothing a link didn't already give.
- **Only PNG, JPEG, GIF and WebP**, checked by their first bytes as well as the declared type. Not SVG, which can carry script. Served with `nosniff` and a `sandbox` content security policy, and cached for good (the id is the content's hash).
- **Browsers shrink big pictures before uploading:** over 2048 pixels on a side or over 1 MB, they're redrawn at most 2048 pixels and sent as WebP (PNG where a browser can't write WebP, JPEG if PNG is too big). A 2048-pixel image takes 16 MB once decoded, which bounds what a board's tab holds per image.
- **Limits:** 5 MB a file (`NIRO_MAX_IMAGE_MB`) and 50 MB per board (`NIRO_MAX_BOARD_IMAGES_MB`), checked under a per-board lock in Postgres so two uploads can't both squeeze under the cap.
- **The engine doesn't know where files live.** The app passes `loadImage(asset)`; the engine caches one decoded picture per file, draws a placeholder until it arrives, and retries a failed load after 10 s. Resizing an image keeps its proportions unless Shift is held, the reverse of other shapes.

## Reactions

- **Six emoji, by name** (`like`, `love`, `laugh`, `party`, `wow`, `eyes`), so what's stored never depends on how an emoji is encoded, and an unknown name from a newer client is ignored.
- **One key per person and reaction in the shape's map:** `reaction.like.<user> = true`. Adding or taking back your own reaction is a set or a delete of your own key, so concurrent reactions from different people never conflict. A nested map or a count would: two people creating the same nested map at once leaves one of them, and two increments of a counter in a last-writer-wins map lose one.
- **`<user>` is a random id each browser makes and keeps in `localStorage`.** There are no accounts ([0002](0002-sharing.md)), so this is honest-client only: anyone with an edit link could write keys for other ids, as they could delete the shape. Viewers can't react, because the server drops everything they send.
- **Reactions are drawn on the board** as a row of pills under the shape, in world units, so they zoom with it; `drawnExtent` includes them. Reading caps them at 1,000 per shape, so a hostile client can't freeze tabs.
- **They go through undo like any other change you make,** and a copy of a shape starts without any.

Both changes raise the board schema to 5, so older versions open such boards read-only rather than drop what they can't draw.

## What this gives up

- **Images that are no longer on the board stay stored.** Nothing removes a file when its last shape goes: the board's undo history, other people's offline copies and duplicates may bring it back, and knowing it's unused means decoding the board. The 50 MB cap bounds it per board; boards cost nothing to create, so it doesn't bound the server, the same as board storage today.
- **Images need the server.** Adding one offline fails with a message; images already loaded stay on screen. A browser with a board saved offline but never online shows placeholders.
- **Images don't move between boards.** Copy and paste of shapes between boards doesn't exist yet; when it does, it has to upload the file to the new board.
- **Animated GIFs show their first frame.** The board is a canvas.
- **SVG export embeds images as PNG data URLs,** which can make big files.

## Alternatives considered

- **Image bytes in the Yjs document:** simplest, works offline and needs no new route, but every image counts against the 5 MB board limit, is held in server memory 25 times over, is sent to every peer on every catch-up, and stays in the history forever after deletion.
- **Object storage (S3 and alikes) with signed URLs:** the right answer at scale, and a later change behind the same `AssetStorage` interface. A self-hosted v0.1 shouldn't need a second storage service.
- **Serving files from the web app:** same origin and no CORS, but the web app would need the database and its own migrations, beside the realtime server that owns them.
- **Reactions as a count per emoji:** smaller, but loses concurrent increments and can't tell whether you already reacted.
