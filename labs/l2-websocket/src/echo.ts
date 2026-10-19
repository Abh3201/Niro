/**
 * An echo server to poke at by hand:
 *
 *   pnpm --filter @niro/lab-l2-websocket start
 *
 * then, in any browser's devtools console:
 *
 *   const ws = new WebSocket("ws://localhost:8080/");
 *   ws.onmessage = (e) => console.log("got", e.data);
 *   ws.onopen = () => ws.send("hello");
 *
 * and watch the frames in the Network panel (filter: WS, then Messages).
 */
import { createWebSocketServer } from "./server";

const port = Number(process.env.PORT ?? 8080);

const server = createWebSocketServer({
  heartbeatMs: 30_000,
  onConnection(ws, request) {
    console.log(`open ${request.path} from ${request.headers.get("origin") ?? "no origin"}`);
    ws.onmessage = (data) => ws.send(data);
    ws.onclose = (code, reason) => console.log(`close ${code}${reason ? ` ${reason}` : ""}`);
  },
});

server.listen(port, () => console.log(`echo server on ws://localhost:${port}/`));
