# Changelog

What changed in each release of Niro, newest first. Anything you have to do when upgrading a self-hosted server is called out under **Upgrading**.

## 0.1.0 (unreleased)

The first release: a whiteboard you can run yourself and share by link.

### Boards

- Sticky notes, rectangles, ellipses, lines, arrows, pen strokes and text. Select, move, resize, rotate, recolor, reorder, duplicate and delete, with undo and redo.
- Text in every box shape, edited in place; text in shapes shrinks to fit.
- Arrows stay attached to the shapes they connect.
- A pen that follows pressure, and ignores the palm resting on a tablet.
- Groups, and frames that hold and clip their contents.
- Pan and zoom with a mouse, a trackpad or touch.
- Export the selection or the whole board as PNG or SVG.
- Keyboard: Tab steps through shapes in reading order, `?` lists every shortcut. Screen readers announce the selected shape and can read a list of the board's shapes.
- Boards of 10,000 shapes stay smooth: only what's on screen is drawn, with less detail when zoomed out.

### Working together

- Every board has an edit link and a view-only link. There are no accounts: a link is the access.
- Edits, cursors and selections appear live for everyone on the board. Typing in the same text at once works.
- Boards are saved in Postgres and in each browser, so they open offline and survive restarts.

### Running it

- `docker compose up` runs the web app, the realtime server and Postgres. `compose.https.yml` adds Caddy for HTTPS on your own domain. See [docs/self-hosting.md](docs/self-hosting.md).
- A demo deploy on Azure App Service's free tier, with Postgres on Neon: [docs/deploy-azure.md](docs/deploy-azure.md).
- Limits per board (shapes, size, people), limits for the whole realtime server (memory for open boards, people), and Prometheus metrics on the realtime server.

### Known limits

- One realtime server per database; it doesn't scale out yet.
- A single link can't be revoked; changing `NIRO_SECRET` revokes them all.
- No comments, images, templates or accounts yet.
