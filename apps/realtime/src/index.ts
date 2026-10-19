import { readSecret } from "@niro/sync/auth";
import { createRealtimeServer } from "./server";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

const server = createRealtimeServer({ secret: readSecret(process.env) });
const address = await server.listen(port, host);
console.log(`niro realtime listening on ${address.address}:${address.port}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, closing connections`);
    await server.close();
    process.exit(0);
  });
}
