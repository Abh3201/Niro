import { googleEnabled } from "~/accounts/db.server";
import { emailEnabled } from "~/accounts/email.server";
import { Contact, LegalPage, operatorName } from "~/legal/LegalPage";
import { getOperator } from "~/legal/site.server";
import type { Route } from "./+types/privacy";

/**
 * The privacy policy. It describes what this code stores, and where the
 * Niro site run by the project's author keeps it (Vercel, Azure, Neon,
 * Resend). If you run Niro elsewhere, change "Who handles it" to match.
 * Change UPDATED whenever the policy changes.
 */
const UPDATED = "30 October 2026";

export function loader() {
  return { operator: getOperator(), google: googleEnabled(), email: emailEnabled() };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Privacy policy · Niro" },
    { name: "description", content: "What Niro stores about you, why, and how to remove it." },
  ];
}

export default function Privacy({ loaderData }: Route.ComponentProps) {
  const { operator } = loaderData;
  const who = operatorName(operator);
  return (
    <LegalPage title="Privacy policy">
      <p className="updated">Last updated {UPDATED}</p>
      <p className="lead">
        Niro is an online whiteboard. This site is run by {who}. Niro keeps what it needs to show
        you your boards, and nothing for advertising. It has no ads, no analytics and no tracking
        cookies, and doesn't sell or rent your information.
      </p>

      <h2>What Niro keeps</h2>
      <h3>Boards</h3>
      <p>
        Everything on a board is stored on Niro's servers so it's there next time: shapes, text,
        drawings, images you add, comments, reactions and saved versions. Comments keep the name you
        wrote them under. A reaction keeps a random id for your browser, so you can take it back.
        Anyone with a board's edit link can read and change all of this, and anyone with a view link
        can read it, so don't put on a board anything you wouldn't give to everyone who has its
        link.
      </p>
      <p>
        While you're on a board, your cursor, selection, name and color are sent to the others on it
        at that moment. They aren't stored. Signed out, the name is a made-up one like "Calm Otter"
        until you type your own. Signed in, it's your account's name until you type your own, and if
        your account has no name (you signed in by email), it's the part of your email address
        before the @.
      </p>

      <h3>Your account (only if you sign in)</h3>
      <p>Signing in is optional. If you sign in, Niro keeps:</p>
      <ul>
        <li>your name, email address and, with Google, your profile picture's address.</li>
        <li>
          your sessions: when each started and expires, and the IP address and browser (user agent)
          it was started from, so you stay signed in and it can't be reused elsewhere.
        </li>
        <li>
          the boards you made or opened while signed in, their names, your access to each, and when
          you last opened it, for <strong>My boards</strong>.
        </li>
        <li>
          for 10 minutes, a sign-in link we emailed you (stored hashed, so it can't be read back),
          and for up to 10 minutes your IP address, to limit how often it can try to sign in.
        </li>
      </ul>

      {loaderData.google && (
        <>
          <h3 id="google">Signing in with Google</h3>
          <p>
            When you choose <strong>Continue with Google</strong>, Google asks you to share your{" "}
            <strong>name, email address and profile picture</strong> with Niro (the{" "}
            <code>openid</code>, <code>email</code> and <code>profile</code> permissions). Niro asks
            for nothing else: not your contacts, files, calendar or mail.
          </p>
          <ul>
            <li>
              <strong>How Niro uses it:</strong> to sign you in, to find your account when you come
              back (by your Google account id and email), and to show your picture and name in your
              account menu. Your name is also shown next to your cursor to the others on a board,
              unless you type another. Your email and picture are shown only to you.
            </li>
            <li>
              <strong>How Niro stores it:</strong> in Niro's database, with your account. The
              sign-in tokens Google returns are stored encrypted, and Niro doesn't use them to call
              Google again.
            </li>
            <li>
              <strong>Who it's shared with:</strong> nobody, except the service providers below that
              host Niro's servers and database. Your name appears to people on a board with you
              while you're on it.
            </li>
            <li>
              Niro doesn't sell Google user data, use it for advertising, use it to train AI or
              machine learning models, or let anyone read it except where you ask (for example, your
              name on a board), for security, or where the law requires.
            </li>
          </ul>
          <p>
            Niro's use and transfer of information received from Google APIs to any other app will
            adhere to the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy">
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
          <p>
            You can remove Niro's access at any time in your Google Account, under{" "}
            <a href="https://myaccount.google.com/connections">Third-party apps and services</a>.
            That stops new sign-ins with Google; to delete what Niro already has, see{" "}
            <a href="#delete">Deleting your information</a>.
          </p>
        </>
      )}

      <h3>In your browser</h3>
      <p>
        Signed in, Niro sets one cookie for your session, and Google sign-in sets a short-lived one
        to check that the reply really is for you. Niro also keeps a few settings in your browser's
        storage, which never leave it unless noted: light or dark mode, your cursor's name and
        color, the random reaction id above, the links you used to open each board (so it opens
        again without the link), and which comments you've seen.
      </p>

      <h3>Server logs</h3>
      <p>
        Like most websites, the services that host Niro record requests, including IP addresses, for
        a short time, to keep it running and secure. Niro counts open boards and connections for its
        own monitoring, without anything that identifies you.
      </p>

      <h2>Who handles it</h2>
      <p>Niro runs on these services, which store or process the information above for it:</p>
      <ul>
        <li>
          <strong>Vercel</strong> serves the web pages and runs sign-in.
        </li>
        <li>
          <strong>Microsoft Azure</strong> runs the server that keeps boards in sync.
        </li>
        <li>
          <strong>Neon</strong> hosts the database with boards, images and accounts.
        </li>
        {loaderData.email && (
          <li>
            <strong>Resend</strong> sends sign-in emails, so it gets your email address and the
            link.
          </li>
        )}
        {loaderData.google && (
          <li>
            <strong>Google</strong> signs you in, if you choose Continue with Google.
          </li>
        )}
      </ul>
      <p>
        These services may store data outside your country. Niro gives them only what they need to
        do these jobs.
      </p>

      <h2>How long it's kept</h2>
      <ul>
        <li>
          Boards are kept until their owner deletes them. Deleting a board stops all of its links
          working and erases its content, images and saved versions. A board without an owner (made
          while signed out) can't be deleted from Niro yet: ask us, below, with its link.
        </li>
        <li>
          A session lasts 30 days from when you last used Niro, or until you sign out. Sign-in links
          last 10 minutes.
        </li>
        <li>Your account is kept until you ask us to delete it.</li>
      </ul>

      <h2 id="delete">Deleting your information</h2>
      <p>
        Email <Contact operator={operator} /> from the address on your account and ask us to delete
        your account. We delete your account, sessions and board list, and, if you ask, the boards
        you own, within 30 days. You can also ask what we hold about you, or to correct it. You can
        delete a board you own yourself, from <strong>My boards</strong>.
      </p>

      <h2>Security</h2>
      <p>
        Niro is served over HTTPS. Board links carry their key after the <code>#</code>, which
        browsers don't send to servers, so keys don't end up in logs. Sign-in links are stored
        hashed and work once. No system is perfectly secure; if you find a problem, please tell us.
      </p>

      <h2>Children</h2>
      <p>
        Niro isn't meant for children under 13, and we don't knowingly keep accounts for them. If
        you think a child has made one, contact us and we'll delete it.
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, we'll update it here and change the date at the top.</p>

      <h2>Contact</h2>
      <p>
        Questions or requests: <Contact operator={operator} />.
      </p>
    </LegalPage>
  );
}
