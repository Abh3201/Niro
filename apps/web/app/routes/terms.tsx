import { Contact, LegalPage, operatorName } from "~/legal/LegalPage";
import { getOperator } from "~/legal/site.server";
import type { Route } from "./+types/terms";

/** The terms of service. Change UPDATED whenever they change. */
const UPDATED = "30 October 2026";

export function loader() {
  return { operator: getOperator() };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Terms of service · Niro" },
    { name: "description", content: "The rules for using Niro." },
  ];
}

export default function Terms({ loaderData }: Route.ComponentProps) {
  const { operator } = loaderData;
  const who = operatorName(operator);
  return (
    <LegalPage title="Terms of service">
      <p className="updated">Last updated {UPDATED}</p>
      <p className="lead">
        These terms are the agreement between you and {who} ("we") for using Niro on this site. By
        using Niro you accept them. If you don't, please don't use it.
      </p>

      <h2>The service</h2>
      <p>
        Niro is a free online whiteboard. We run it as a personal project, and may change it, limit
        it (for example, how large a board can be), or stop it at any time. Keep your own copy of
        anything important: you can export a board as PNG or SVG.
      </p>

      <h2>Your account</h2>
      <p>
        You don't need an account to use Niro. If you make one, keep access to your email or Google
        account safe, since that's how you sign in, and tell us if you think someone else got in.
        You must be at least 13 to use Niro.
      </p>

      <h2>Your boards and content</h2>
      <ul>
        <li>
          What you put on a board stays yours. You let us store it, copy it between our servers, and
          show it to the people who have the board's link, which is what running Niro needs.
        </li>
        <li>
          Anyone with a board's edit link can change or delete what's on it, and anyone with its
          view link can see it. Share links with care: you're responsible for who you give them to.
        </li>
        <li>You need the right to everything you add, such as images.</li>
      </ul>

      <h2>Things you must not do</h2>
      <ul>
        <li>Break the law, or put on Niro anything illegal.</li>
        <li>
          Harass people, or share content that's abusive, hateful or sexually exploits anyone.
        </li>
        <li>Infringe someone's copyright, trademark, privacy or other rights.</li>
        <li>Upload malware, phish, or spam.</li>
        <li>
          Try to break into Niro, get around its limits, or overload it (automated use at a volume a
          person couldn't produce).
        </li>
      </ul>
      <p>
        We may remove content or boards, or close accounts, that break these rules, or to protect
        Niro and the people using it.
      </p>

      <h2>No warranty</h2>
      <p>
        Niro is provided "as is" and "as available", without warranties of any kind, to the extent
        the law allows. We try to keep it working and your boards safe, but we can't promise it will
        always be available, free of bugs, or that nothing will ever be lost.
      </p>

      <h2>Limit of liability</h2>
      <p>
        To the extent the law allows, we aren't liable for indirect or consequential losses, or for
        lost data, profits or work, arising from your use of Niro, and our total liability to you is
        limited to what you've paid us for it (Niro is free). Nothing here limits rights you have by
        law that can't be limited.
      </p>

      <h2>Privacy</h2>
      <p>
        How we handle your information is in the <a href="/privacy">privacy policy</a>.
      </p>

      <h2>Changes and ending</h2>
      <p>
        We may update these terms; the date at the top says when they last changed, and using Niro
        after a change means you accept it. You can stop using Niro at any time and ask us to delete
        your account.
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <Contact operator={operator} />.
      </p>
    </LegalPage>
  );
}
