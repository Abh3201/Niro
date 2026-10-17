/** Test helpers: a realtime server on a free port, and browser tabs that connect to it. */
import {
  type BoardStorage,
  fromWebSocket,
  type MemoryStorage,
  PROTOCOL_VERSION,
  type Role,
  SyncClient,
} from "@niro/sync";
import { issueToken } from "@niro/sync/auth";
import { WebSocket } from "ws";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createRealtimeServer, type RealtimeServer, type RealtimeServerOptions } from "./server";

export const SECRET = "test-secret-0123456789abcdef0123456789";
export const BOARD = "board-0123456789";

export interface Tab {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly client: SyncClient;
  /** Closes the tab for good: it won't reconnect. */
  close(): void;
}

export class Harness {
  server!: RealtimeServer;
  base = "";
  private readonly tabs: Tab[] = [];

  /** Starts a server. Stop or close the previous one first. */
  async start(options: Partial<RealtimeServerOptions> = {}): Promise<RealtimeServer> {
    this.server = createRealtimeServer({ secret: SECRET, ...options });
    const { port } = await this.server.listen(0, "127.0.0.1");
    this.base = `127.0.0.1:${port}`;
    return this.server;
  }

  url(token: string, board = BOARD, v = PROTOCOL_VERSION): string {
    return `ws://${this.base}/ws?v=${v}&board=${board}&token=${encodeURIComponent(token)}`;
  }

  token(role: Role = "edit", board = BOARD): string {
    return issueToken(SECRET, board, role);
  }

  /**
   * A browser tab: a doc, presence and a SyncClient over a real WebSocket
   * (Node's built-in one). It reconnects to whichever server is current.
   */
  tab(role: Role = "edit", board = BOARD): Tab {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const client = new SyncClient({
      doc,
      awareness,
      connect: () =>
        fromWebSocket(new globalThis.WebSocket(this.url(this.token(role, board), board))),
    });
    let closed = false;
    const tab: Tab = {
      doc,
      awareness,
      client,
      close() {
        if (closed) return;
        closed = true;
        client.destroy();
        awareness.destroy();
      },
    };
    this.tabs.push(tab);
    return tab;
  }

  /** A raw WebSocket (from the `ws` package), open. */
  async socket(role: Role = "edit", board = BOARD): Promise<WebSocket> {
    const ws = new WebSocket(this.url(this.token(role, board), board));
    ws.on("error", () => {});
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    return ws;
  }

  /** The HTTP status the server answers an upgrade with, or 101. */
  upgradeStatus(address: string): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(address);
      ws.once("open", () => {
        ws.close();
        resolve(101);
      });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("error", () => {});
    });
  }

  /** Closes every tab, then the server. */
  async stop(): Promise<void> {
    for (const tab of this.tabs.splice(0)) tab.close();
    await this.server.close();
  }
}

export async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves with the close code once `ws` closes. */
export function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

/** `storage`, with every write taking `ms` longer. */
export function slowWrites(storage: MemoryStorage, ms: number): BoardStorage {
  const later = () => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    load: (id) => storage.load(id),
    append: (id, update) => later().then(() => storage.append(id, update)),
    replace: (id, state) => later().then(() => storage.replace(id, state)),
  };
}
