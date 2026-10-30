import { useState } from "react";
import { redirect } from "react-router";
import { getUser, signInMethods } from "~/accounts/auth.server";
import { accountsEnabled } from "~/accounts/db.server";
import type { Route } from "./+types/signin";

/** Where to go after signing in: a path on this site, never another site. */
function safeNext(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/boards";
  }
  return value;
}

const ERRORS: Record<string, string> = {
  google: "Signing in with Google didn't work. Try again.",
  link: "That sign-in link has expired or was already used. Ask for a new one.",
};

export async function loader({ request }: Route.LoaderArgs) {
  if (!accountsEnabled()) return redirect("/");
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (await getUser(request)) return redirect(next);
  const error = url.searchParams.get("error");
  return {
    next,
    methods: signInMethods(),
    error: error ? (ERRORS[error] ?? "Signing in didn't work. Try again.") : null,
  };
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Sign in · Niro" }];
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const { next, methods, error } = loaderData;
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(error);
  const [busy, setBusy] = useState(false);

  const google = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          callbackURL: next,
          errorCallbackURL: "/signin?error=google",
        }),
      });
      const answer = (await response.json()) as { url?: string };
      if (!response.ok || !answer.url) throw new Error(String(response.status));
      window.location.assign(answer.url);
    } catch {
      setProblem(ERRORS.google ?? null);
      setBusy(false);
    }
  };

  const email = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (!address) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: address,
          callbackURL: next,
          errorCallbackURL: "/signin?error=link",
        }),
      });
      if (response.status === 429) {
        setProblem("Too many sign-in emails. Wait a few minutes and try again.");
      } else if (!response.ok) {
        setProblem("The email couldn't be sent. Check the address and try again.");
      } else {
        setSent(address);
      }
    } catch {
      setProblem("You seem to be offline. Try again when you're connected.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page signin-page">
      <div className="signin-card">
        <h1>
          <a href="/" className="brand">
            Niro
          </a>
        </h1>
        {sent ? (
          <div role="status" data-testid="link-sent">
            <h2>Check your email</h2>
            <p>
              We sent a sign-in link to <strong>{sent}</strong>. It works once, for 10 minutes.
            </p>
            <button type="button" className="text-button" onClick={() => setSent(null)}>
              Use another address
            </button>
          </div>
        ) : (
          <>
            <h2>Sign in to keep your boards</h2>
            <p className="hint">
              Your boards are saved to your account, so you can open them from any device. Share
              links keep working for everyone else.
            </p>
            {problem && (
              <p className="form-error" role="alert" data-testid="signin-error">
                {problem}
              </p>
            )}
            {methods.google && (
              <button
                type="button"
                className="google-button"
                disabled={busy}
                onClick={google}
                data-testid="google-sign-in"
              >
                <GoogleMark />
                Continue with Google
              </button>
            )}
            {methods.google && methods.email && <p className="divider">or</p>}
            {methods.email && (
              <form onSubmit={email} className="email-form">
                <label htmlFor="email">Email</label>
                <input
                  className="text-field"
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  data-testid="signin-email"
                />
                <button type="submit" className="submit" disabled={busy} data-testid="send-link">
                  Email me a sign-in link
                </button>
              </form>
            )}
          </>
        )}
        <p className="hint small">
          <a href="/">Or start a board without an account</a>
        </p>
      </div>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}
