# Self-hosting Niro

Niro is three containers: the web app, the realtime server and Postgres. This guide takes you from nothing to a board on your own domain with HTTPS, then covers backups, upgrades and what to watch.

## What you need

- A machine with Docker Engine and Docker Compose v2.24 or newer (`docker compose version`). Boards are held in the realtime server's memory while someone has them open, so memory is what grows with use. A small machine (1 CPU, 1 GB) should be fine for a team, but that's an estimate: Niro hasn't been load-tested yet.
- For a public server: a domain name whose DNS points at the machine, and ports 80 and 443 open.

## Try it on your own machine

```sh
git clone https://github.com/Abh3201/Niro.git && cd Niro
echo "NIRO_SECRET=$(openssl rand -hex 32)" > .env
docker compose up --build
```

Open http://localhost:3000. Every visit to `/` makes a new board; its address is the board's edit link. Other machines on your network can use `http://<this machine's address>:3000`. Over plain HTTP the **Copy** buttons in the share panel don't work on other machines (browsers allow the clipboard only on HTTPS and `localhost`), so select the link and copy it by hand.

No server of your own? [deploy-azure.md](deploy-azure.md) runs a small demo on Azure App Service's free tier.

## Put it on a server, with HTTPS

[`compose.https.yml`](../compose.https.yml) adds [Caddy](https://caddyserver.com) in front of both services. Caddy gets a certificate from Let's Encrypt, sends the board's WebSocket (`/ws`) to the realtime server and everything else to the web app, all on one domain. Only Caddy is published; the web app, the realtime server's `/healthz` and `/metrics`, and Postgres stay inside the compose network.

```sh
cat > .env <<EOF
NIRO_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
NIRO_DOMAIN=board.example.com
EOF
docker compose -f docker-compose.yml -f compose.https.yml up --build -d
```

Then open https://board.example.com. The first request can take a few seconds while Caddy gets the certificate; `docker compose -f docker-compose.yml -f compose.https.yml logs caddy` shows how that went.

Put the two `-f` options in `COMPOSE_FILE` so the shorter commands below work: add `COMPOSE_FILE=docker-compose.yml:compose.https.yml` to `.env`.

### Another reverse proxy

Any proxy that passes WebSockets works. It needs to:

1. Send `/ws` (with its query string) to the realtime server, port 8787, with the WebSocket upgrade headers. The connection stays open as long as the board is; the server pings every 30 seconds, so a proxy idle timeout of 60 seconds or more is enough.
2. Send everything else to the web app, port 3000.
3. Have `PUBLIC_REALTIME_URL` set on the web app to where browsers reach the realtime server, `wss://board.example.com` here. Browsers add `/ws` themselves.

For nginx, the `/ws` part looks like this:

```nginx
location = /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
}
```

The realtime server can also live on a domain of its own (`PUBLIC_REALTIME_URL=wss://realtime.example.com`), proxied whole to port 8787.

## Settings

Set these in `.env`, next to `docker-compose.yml`.

| Setting | Default | What it does |
|---|---|---|
| `NIRO_SECRET` | none, required | Signs share links. 32 or more characters; both services must have the same one. See [Security](#security). |
| `POSTGRES_PASSWORD` | `niro` | The database password. Change it anywhere but your own machine. It's set when the database is first created: to change it later, change it in Postgres too (`ALTER USER niro PASSWORD '...'`). |
| `NIRO_DOMAIN` | none | Your domain, for `compose.https.yml`. |
| `PUBLIC_REALTIME_URL` | the web app's host, port 8787 | Where browsers open the WebSocket, `ws://` or `wss://`. `compose.https.yml` sets it from `NIRO_DOMAIN`. |
| `WEB_PORT`, `REALTIME_PORT` | 3000, 8787 | Ports published without `compose.https.yml`. If you change `REALTIME_PORT`, set `PUBLIC_REALTIME_URL` to match. |
| `METRICS_TOKEN` | none | When set, `/metrics` needs `Authorization: Bearer <token>`. Set it if port 8787 is reachable from outside. |
| `NIRO_MAX_SHAPES` | 10000 | Shapes on one board. A board at the limit turns read-only for everyone, and says so. |
| `NIRO_MAX_BOARD_MB` | 20 | Size of one board, in MB of stored document. Same as above. |
| `NIRO_MAX_CONNECTIONS_PER_BOARD` | 100 | People (browser tabs) on one board at once; more are turned away. |

## Backups

Everything lives in Postgres, in the `pgdata` volume. Back it up with `pg_dump`; it works while people are editing.

```sh
docker compose exec -T postgres pg_dump -U niro -Fc niro > niro-$(date +%F).dump
```

Changes reach the database within 2 seconds of the last edit on a board (10 seconds at most while people keep editing), so a backup misses at most that much. Copy the dump somewhere other than this machine. A daily cron entry is a reasonable start.

To restore, stop the realtime server so it doesn't write in the middle, restore, and start it again:

```sh
docker compose stop realtime
docker compose exec -T postgres pg_restore -U niro -d niro --clean --if-exists < niro-2026-10-18.dump
docker compose start realtime
```

Keep `NIRO_SECRET` with your backups. Without it the boards are still there, but no existing link opens them.

## Upgrades

```sh
git pull
docker compose up --build -d
```

The realtime server updates the database schema itself when it starts. On stop, it writes every open board before exiting (compose gives it 30 seconds), and browsers reconnect when it's back, so an upgrade looks like a short network blip. Read [CHANGELOG.md](../CHANGELOG.md) first: anything that needs you to act is listed there.

Postgres itself stays on major version 18. Moving to a new major version means a dump and restore into a new volume, as with any Postgres.

## Watching it

- `GET /healthz` on the realtime server answers `200` while it's up. The compose file uses it (and the web app's `/`) as health checks; `docker compose ps` shows them.
- `GET /metrics` on the realtime server, in the Prometheus format. The ones worth an alert:
  - `niro_storage_errors_total` rising: writes to Postgres are failing. Edits keep working and are retried, but they're only in memory until it recovers.
  - `niro_unwritten_changes` staying high: the same, seen from the other side.
  - `niro_rooms_read_only`: boards that hit a limit.
  - `niro_connections_rejected_total` by `reason`: people turned away (bad links, full boards, wrong protocol version after an upgrade with old tabs open).
- Logs: `docker compose logs -f realtime web`.

With `compose.https.yml`, `/metrics` isn't reachable from outside. To scrape it, publish port 8787 to your monitoring network only, with `METRICS_TOKEN` set.

## Limits to know about

- **One realtime server per database.** Two servers would each compact away the other's writes. Niro v0.1 doesn't scale out; one server holds a lot of boards (see [decision 0003](decisions/0003-storage.md)).
- **Board size.** 10,000 shapes or 20 MB per board by default, as above.
- **No accounts.** Anyone with a link has its access; see below.

## Security

- **Links are the access control.** An edit link lets anyone who has it edit that board, a view link lets them view it. Send links only to people who should have them.
- **You can't revoke one link.** Changing `NIRO_SECRET` revokes every link to every board at once; boards stay in the database, but nobody can open them with an old link. Why it works this way: [decision 0002](decisions/0002-sharing.md).
- **Keep `NIRO_SECRET` secret and stable.** Anyone with it can make a link to any board. It's in `.env`; keep that file out of version control (`.gitignore` already does) and readable only by you.
- **Links stay out of server logs.** The key is in the URL fragment, which browsers never send. The WebSocket carries a token that expires after 60 seconds, so a proxy log that records it holds nothing useful.
- **Use HTTPS on anything but your own network.** Over plain HTTP, anyone on the path can read the links and the boards.
- **Change `POSTGRES_PASSWORD`**, and don't publish the Postgres port; the compose file doesn't.

## Troubleshooting

| You see | Likely cause |
|---|---|
| `Set NIRO_SECRET in .env first` | `.env` is missing or has no `NIRO_SECRET`. Run the `echo` line from the top of this guide. |
| The board loads but says it's offline, and other people's edits don't arrive | Browsers can't reach the WebSocket. Behind a proxy, check `PUBLIC_REALTIME_URL` (it must start with `wss://` on an HTTPS site) and that `/ws` reaches port 8787 with the upgrade headers. In the browser's developer tools, the Network tab's WS filter shows the attempt. |
| Every link stopped working after a restart | `NIRO_SECRET` changed. Put back the old one. |
| `password authentication failed` in the realtime logs | `POSTGRES_PASSWORD` changed after the database was created; see [Settings](#settings). |
| A board says it's read-only | It reached `NIRO_MAX_SHAPES` or `NIRO_MAX_BOARD_MB`, or you have a view link. |
| Caddy can't get a certificate | DNS for `NIRO_DOMAIN` doesn't point at this machine yet, or ports 80 and 443 are closed. |
