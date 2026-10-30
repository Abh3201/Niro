import { SiteFooter } from "./SiteFooter";
import type { Operator } from "./site.server";

/** The frame for About, Privacy and Terms: brand, one readable column, footer. */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="page legal-page">
      <header className="legal-header">
        <a href="/about" className="brand">
          Niro
        </a>
        <a href="/" className="primary-button">
          Start a board
        </a>
      </header>
      <article className="legal-body">
        <h1>{title}</h1>
        {children}
      </article>
      <SiteFooter />
    </main>
  );
}

/** "Ada Lovelace", or a description when the site hasn't named its operator. */
export function operatorName(operator: Operator): string {
  return operator.name ?? "the people who run this Niro site";
}

/** How to reach the operator: their email, or where to find out. */
export function Contact({ operator }: { operator: Operator }) {
  return operator.email ? (
    <a href={`mailto:${operator.email}`} data-testid="contact-email">
      {operator.email}
    </a>
  ) : (
    <span data-testid="contact-missing">
      the contact address this site's operator gives (none is set up yet)
    </span>
  );
}
