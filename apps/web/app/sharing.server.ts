/**
 * Share links, on the server. See `@niro/sync/auth` for how keys and tokens
 * work, and docs/decisions/0002-sharing.md for why.
 */
import { readSecret } from "@niro/sync/auth";

let secret: string | undefined;

/** `NIRO_SECRET`, read on first use so building the app doesn't need it. */
export function getSecret(): string {
  secret ??= readSecret(process.env);
  return secret;
}

/** Port the realtime server listens on when `PUBLIC_REALTIME_URL` isn't set. */
const DEFAULT_REALTIME_PORT = 8787;

/**
 * Where browsers open the realtime WebSocket: `PUBLIC_REALTIME_URL`, or else
 * the host this page was requested from on port 8787. That default works on
 * one machine and on a LAN; behind a reverse proxy, set the variable.
 */
export function realtimeUrl(request: Request): string {
  const configured = process.env.PUBLIC_REALTIME_URL;
  if (configured) {
    if (!/^wss?:\/\//.test(configured)) {
      throw new Error("PUBLIC_REALTIME_URL must start with ws:// or wss://");
    }
    return configured.replace(/\/+$/, "");
  }
  const url = new URL(request.url);
  const scheme = url.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${url.hostname}:${DEFAULT_REALTIME_PORT}`;
}
