import { accountsEnabled } from "~/accounts/db.server";
import { LegalPage } from "~/legal/LegalPage";
import type { Route } from "./+types/about";

/**
 * What Niro is, for people (and Google's reviewers) who haven't opened a
 * board yet. `/` itself starts a new board, so this is the site's home page.
 */
export function loader() {
  return { accounts: accountsEnabled() };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Niro: a whiteboard for thinking together" },
    {
      name: "description",
      content:
        "Niro is a free online whiteboard: sticky notes, shapes, drawing and comments, together in real time.",
    },
  ];
}

export default function About({ loaderData }: Route.ComponentProps) {
  return (
    <LegalPage title="A whiteboard for thinking together">
      <p className="lead">
        Niro is a free online whiteboard for thinking together. Open a board, share its link, and
        everyone with the link sees each other's changes and cursors as they happen.
      </p>
      <h2>What you can do</h2>
      <ul>
        <li>
          Sticky notes, shapes, text, arrows, freehand drawing and images on an endless canvas.
        </li>
        <li>Work on the same board at once, with live cursors, follow mode and a laser pointer.</li>
        <li>Frames and presentation mode, comments, emoji reactions and version history.</li>
        <li>Share a link that can edit, or one that can only view.</li>
        <li>Export a board as PNG or SVG.</li>
        {loaderData.accounts && (
          <li>
            Sign in with Google or by email to keep a list of your boards and open them on any
            device. Signing in is optional.
          </li>
        )}
      </ul>
      <h2>Get started</h2>
      <p>
        <a href="/">Start a board</a>: no account needed.
        {loaderData.accounts && (
          <>
            {" "}
            Or <a href="/signin">sign in</a> to see your boards.
          </>
        )}
      </p>
      <p>
        How Niro handles your information is in the <a href="/privacy">privacy policy</a>, and the
        rules for using it are in the <a href="/terms">terms of service</a>.
      </p>
    </LegalPage>
  );
}
