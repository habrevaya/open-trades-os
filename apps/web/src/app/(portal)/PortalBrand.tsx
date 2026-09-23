import { getDb } from "@/lib/db";
import { portal } from "@opentradesos/api/services";

/**
 * THE CONTRACTOR'S NAME ON THE PAGE THEIR CUSTOMER OPENS
 *
 * These three pages are the only part of the product a homeowner ever sees,
 * and until now they were the only part that could not be branded: the
 * branding read takes an actor and there is no actor here, only a link.
 *
 * So it resolves from the token, which is the same thing every other read on
 * these pages does. Nothing here takes an organization id, which is what
 * makes it safe to serve to somebody with no account.
 *
 * Rendered per page rather than in the layout. The layout has no token: it
 * would have to read one out of the pathname, which is a coupling between a
 * URL shape and a component that would break quietly the first time a route
 * moved.
 */
export async function PortalBrand({ token, children }: {
  token: string;
  children: React.ReactNode;
}) {
  const brand = await portal.brandingFor(getDb(), token).catch(() => null);

  /**
   * The whole page is inside the palette, not just the mark.
   *
   * The first version wrapped only the header, which put the company's
   * colours on the one part of the page that has no buttons on it. The
   * approve button on a proposal is the single most branded thing here.
   */
  const palette = brand?.color
    ? {
        "--brand": brand.color,
        "--brand-on": brand.on ?? "#ffffff",
        "--brand-text": brand.text ?? brand.color,
      } as React.CSSProperties
    : undefined;

  return (
    <div style={palette} className="space-y-6">
      {brand?.hasLogo && (
        <img
          /*
            The token travels with the request. It is already in the URL of
            the page this sits on, so it is not a new disclosure, and without
            it the logo is the one thing on the page that would need a login
            to load.
          */
          src={`/brand/logo?t=${encodeURIComponent(token)}&v=${brand.version}`}
          alt={brand.organizationName}
          className="mx-auto h-12 max-w-[200px] object-contain"
        />
      )}
      {children}
    </div>
  );
}
