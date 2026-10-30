/**
 * Accounts, with Better Auth (https://better-auth.com): Google sign-in when
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, and a sign-in link
 * by email when email can be sent (email.server.ts). Sessions are kept in
 * the database, in a cookie on the web app's own domain.
 */
import { createHmac } from "node:crypto";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { magicLink } from "better-auth/plugins/magic-link";
import { getSecret } from "~/sharing.server";
import { accountsEnabled, getPool, googleEnabled, setUpDatabase } from "./db.server";
import { emailEnabled, sendEmail, signInEmail } from "./email.server";

/** The signed-in person, as the app uses them. */
export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
}

/** Which ways to sign in are set up. */
export interface SignInMethods {
  readonly google: boolean;
  readonly email: boolean;
}

export function signInMethods(): SignInMethods {
  return {
    google: googleEnabled(),
    email: emailEnabled(),
  };
}

/** A sign-in link lasts this long, and works once. */
const LINK_SECONDS = 10 * 60;

/** Where the app is, for Google's redirect and for links in emails. Required in production. */
function publicUrl(): string | undefined {
  const configured = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  if (configured) {
    if (!/^https?:\/\//.test(configured)) throw new Error("PUBLIC_URL must start with https://");
    return configured;
  }
  // Development: Better Auth takes the address from each request.
  // (`accountsEnabled` is false in production without PUBLIC_URL.)
  return undefined;
}

function options(): BetterAuthOptions {
  const methods = signInMethods();
  const baseURL = publicUrl();
  return {
    appName: "Niro",
    ...(baseURL && { baseURL, trustedOrigins: [baseURL] }),
    basePath: "/api/auth",
    // From NIRO_SECRET, so there's no second secret to keep; labelled, so
    // nothing signed for sessions can pass for a share key or a token.
    secret: createHmac("sha256", getSecret()).update("niro:better-auth").digest("hex"),
    database: getPool() as NonNullable<ReturnType<typeof getPool>>,
    socialProviders: methods.google
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
            prompt: "select_account",
          },
        }
      : {},
    plugins: methods.email
      ? [
          magicLink({
            expiresIn: LINK_SECONDS,
            storeToken: "hashed",
            sendMagicLink: ({ email, url }) => sendEmail(signInEmail(email, url)),
          }),
        ]
      : [],
    account: {
      // Google checks that people own their address, so signing in with it
      // and with an emailed link reaches the same account.
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      // Extended at most once a day by use, not on every request.
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      // Many instances on serverless hosts: a limit in memory would be per instance.
      storage: "database",
      customRules: {
        // Each sends an email: few per IP.
        "/sign-in/magic-link": { window: 60 * 10, max: 5 },
      },
    },
    advanced: {
      // Vercel sets the first; Caddy and most proxies the second.
      ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for", "x-forwarded-for"] },
    },
    telemetry: { enabled: false },
  };
}

type Auth = ReturnType<typeof betterAuth>;
let auth: Auth | undefined;
let ready: Promise<void> | undefined;

/**
 * Better Auth, with the database set up. Throws when there are no accounts
 * (no `DATABASE_URL`); check `accountsEnabled()` first.
 */
export async function getAuth(): Promise<Auth> {
  if (!accountsEnabled()) throw new Error("Accounts need DATABASE_URL and a way to sign in.");
  const config = options();
  const pool = getPool();
  // Tables first: Better Auth checks them when it starts.
  if (pool) {
    ready ??= setUpDatabase(pool, async () => {
      const { runMigrations } = await getMigrations(config);
      await runMigrations();
    }).catch((error: unknown) => {
      // Try again on the next request (the database may have been asleep).
      ready = undefined;
      throw error;
    });
    await ready;
  }
  auth ??= betterAuth(config);
  return auth;
}

/** Whoever is signed in on this request, or null (also when there are no accounts). */
export async function getUser(request: Request): Promise<User | null> {
  if (!accountsEnabled()) return null;
  const session = await (await getAuth()).api.getSession({ headers: request.headers });
  if (!session) return null;
  const { id, name, email, image } = session.user;
  return { id, name: name || email.split("@")[0] || email, email, image: image ?? null };
}
