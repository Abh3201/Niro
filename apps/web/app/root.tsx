import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
// The handwriting font, served with the app (SIL Open Font License).
import "@fontsource/kalam/400.css";
import "@fontsource/kalam/700.css";
import { THEME_SCRIPT } from "./board/theme";

export const links: Route.LinksFunction = () => [
  // The Niro mark (apps/web/public). favicon.ico for browsers without SVG icons.
  { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // The theme script sets data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant, ours. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Not found" : error.status === 410 ? "Board deleted" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.status === 410
          ? "Its owner deleted this board, so its links don't open it anymore."
          : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="error-page">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre>
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
