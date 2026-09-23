/**
 * THE DEVELOPMENT CHROME, HIDDEN
 *
 * Next.js draws an indicator over the corner of every page in development,
 * and every capture in this repository is taken against a dev server. A
 * screenshot with it in is one somebody ships to a marketing page, where it
 * reads as a UI element of the product.
 *
 * Shared between the two capture scripts rather than copied. It started as a
 * copy with a comment saying it was kept identical to the other one, and by
 * the time the second script ran the two had already diverged: the newer
 * selectors were in one of them and the trade screenshots came out with the
 * indicator sitting on top of the sign out button. A comment asserting two
 * things are the same is not a mechanism for keeping them the same.
 */
export const HIDE_DEV = `
  nextjs-portal,
  [id^="__next"],
  [data-nextjs-toast],
  [data-nextjs-dev-tools-button],
  [data-next-badge-root],
  [class*="dev-tools-indicator"] { display: none !important; }
`;
