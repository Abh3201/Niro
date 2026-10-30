/**
 * Links every page outside a board shows. Google checks that the home page
 * links to the privacy policy, and that it's the same page as on the
 * OAuth consent screen.
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav aria-label="About Niro">
        <a href="/about">About</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </nav>
    </footer>
  );
}
