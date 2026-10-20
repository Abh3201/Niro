import { type BoardStorage, MemoryStorage } from "@niro/sync";
import { readSecret } from "@niro/sync/auth";
import { type AssetStorage, MemoryAssets } from "./assets";
import { limitsFromEnv } from "./config";
import { PostgresStorage } from "./postgres";
import { createRealtimeServer } from "./server";
import { MemoryVersions, type VersionStorage } from "./versions";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;
const production = process.env.NODE_ENV === "production";

const secret = readSecret(process.env);
const limits = limitsFromEnv(process.env);
const storage = await openStorage();
const server = createRealtimeServer({
  secret,
  storage,
  // Postgres keeps images in the same database; in memory, they go with the boards.
  assets: storage instanceof PostgresStorage ? storage : (new MemoryAssets() as AssetStorage),
  versions: storage instanceof PostgresStorage ? storage : (new MemoryVersions() as VersionStorage),
  limits,
  ...(process.env.METRICS_TOKEN ? { metricsToken: process.env.METRICS_TOKEN } : {}),
});
const address = await server.listen(port, host);
console.log(`niro realtime listening on ${address.address}:${address.port}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received: closing connections and writing every board`);
    await server.close();
    if (storage instanceof PostgresStorage) await storage.close();
    process.exit(0);
  });
}

async function openStorage(): Promise<BoardStorage> {
  if (!databaseUrl) {
    if (production) {
      console.error(
        "DATABASE_URL is not set. Without it boards live in memory and are lost on restart; " +
          "set it to a Postgres database (docker-compose.yml does).",
      );
      process.exit(1);
    }
    console.warn("DATABASE_URL is not set: keeping boards in memory, lost on restart.");
    return new MemoryStorage();
  }
  // The database may still be starting (a fresh container): keep trying for a while.
  for (let attempt = 1; ; attempt++) {
    try {
      return await PostgresStorage.open(databaseUrl, {
        onError: (error) => console.error("postgres connection error:", error.message),
      });
    } catch (error) {
      if (attempt >= 10) throw error;
      console.warn(`postgres not ready (${(error as Error).message}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.min(attempt, 5)));
    }
  }
}
