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
- Images: add one with the toolbar button, by pasting, or by dropping a file on the board. Files are kept by the realtime server, not in the board.
- Copy, cut and paste shapes, within a board and between boards and tabs; pasted text becomes a text shape.
- Snapping: a shape you move lines up with the edges and centers of other shapes, with guide lines; Alt turns it off.
- Follow mode: click a collaborator's avatar to see what they see. A laser pointer (`K`) leaves a fading trail for everyone, including view-only visitors.
- Lock shapes against accidental moves, edits and deletes; line and arrow styles (solid, dashed, dotted; thin, medium, thick; heads at either end). Boards use schema 6 or later, so older clients open them read-only.
- Pen strokes that start on a sticky note belong to it: they move, copy, delete and export with the note (a highlight shows which note the pen will write on; hold Alt as you start to draw on the board instead). Boards use schema 7. Marks drawn earlier stay on the board.
- Images go on sticky notes too: an image pasted or added while one note is selected, or dropped on a note, is shrunk to fit it, set in its middle and moves with it. An image dragged onto a note joins it when it's no bigger than the note; copied strokes and images pasted onto a note join it the same way.
- Text formatting for notes, shapes and text: font (sans, serif, mono, hand), size, bold, italic, underline, strikethrough, alignment across and down, and text color, from a panel under the selection or with Ctrl/⌘ + B, I, U (also while typing). The panel shows the first time text is selected, then folds into the `Aa` button in the selection bar; opening it again keeps it open (remembered per browser). It applies to a shape's whole text; a size set on a note is the largest, and longer text still shrinks to fit. Boards use schema 9.
- Formatting on parts of the text: while typing, the panel and Ctrl/⌘ + B, I, U format the selected words, and alignment the selected paragraphs; with nothing selected, they're for what's typed next. A new line carries on in the style of the line before it. Formatting a selected shape still applies to all its text. New notes, shapes and text are written in Hand, now the Kalam handwriting font served with the app (SIL Open Font License); existing text keeps its font. Boards use schema 10.
- Search: Ctrl/⌘ + F finds text in notes, shapes, text and frame names, outlines every match and steps through them with Enter.
- Minimap: the whole board drawn small in the corner, with the part on screen outlined; click or drag it to move there, or hide it (the choice is remembered).
- Presentation mode: Present in the `⋯` menu next to the zoom controls (Shift Alt P) steps through the frames in reading order with the arrow keys, Page Up and Down or the on-screen buttons. Others see who is presenting and can follow with one click.
- Elbow arrows: switch an arrow to an elbow in the selection panel and it runs in right angles around the shapes it joins, following them as they move. Boards use schema 8.
- Version history: save a named version of the board, or let Niro save one every half hour of editing; look at any of them and restore one. Restoring is a normal change everyone receives, and Ctrl+Z undoes it. Up to 30 versions and 25 MB per board (`NIRO_MAX_VERSIONS`, `NIRO_MAX_BOARD_VERSIONS_MB`).
- Comments: press `C` (or use the comments button in the toolbar, which also lists them), click where it goes (on a shape, the pin follows it), and write. Others reply, resolve or delete the thread; a ring shows threads with something new. People with a view link can read them but not write.
- Emoji reactions on any shape, shown under it for everyone.
- Pan and zoom with a mouse, a trackpad or touch.
- Export the selection or the whole board as PNG or SVG.
- Light and dark boards: boards are light until you switch with the button next to the zoom controls. Each browser remembers its own choice.
- A Niro icon for browser tabs, bookmarks and home screens.
- Keyboard: Tab steps through shapes in reading order, `?` lists every shortcut. Screen readers announce the selected shape and can read a list of the board's shapes.
- Boards of 10,000 shapes stay smooth: only what's on screen is drawn, with less detail when zoomed out.

### Working together

- Every board has an edit link and a view-only link: a link is the access.
- Optional accounts: sign in with Google or an emailed link (no passwords), and **My boards** lists the boards you made or opened, on any device, to open, rename and delete. Deleting a board stops its links working and erases it from the server. Off until set up: [docs/accounts.md](docs/accounts.md), [decision 0015](docs/decisions/0015-accounts.md).
- Privacy policy (`/privacy`), terms of service (`/terms`) and an about page (`/about`), linked from sign-in and My boards, as Google's OAuth consent screen asks. They name the site's operator and contact from `NIRO_OPERATOR` and `NIRO_CONTACT_EMAIL`. Google sign-in tokens are now stored encrypted.
- Edits, cursors and selections appear live for everyone on the board. Typing in the same text at once works.
- Boards are saved in Postgres and in each browser, so they open offline and survive restarts.

### Running it

- `docker compose up` runs the web app, the realtime server and Postgres. `compose.https.yml` adds Caddy for HTTPS on your own domain. See [docs/self-hosting.md](docs/self-hosting.md).
- A demo deploy on Azure App Service's free tier, with Postgres on Neon: [docs/deploy-azure.md](docs/deploy-azure.md). The guide shows how a free uptime monitor keeps the realtime server from idling out; `/healthz` answers `HEAD` as well as `GET` for it.
- The web app can run on Vercel, on your own domain, with the realtime server elsewhere: [docs/deploy-vercel.md](docs/deploy-vercel.md).
- Limits per board (shapes, size, people), limits for the whole realtime server (memory for open boards, people), and Prometheus metrics on the realtime server.

### Known limits

- One realtime server per database; it doesn't scale out yet.
- A single link can't be revoked; changing `NIRO_SECRET` revokes them all.
- No templates yet.
- Accounts can't remove one person's access to a board yet.
