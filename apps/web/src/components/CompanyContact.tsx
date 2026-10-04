import { Phone } from "@opentradesos/ui";
import { branding, type branding as brand } from "@opentradesos/core";

/**
 * HOW A CUSTOMER REACHES THE COMPANY, UNDER ITS NAME
 *
 * Drawn on the proposal, the statement and the top of every customer page,
 * from the one record the company sets on Settings. The phone dials and the
 * email opens a message, because the person reading is usually on a phone
 * with a question about the paper in front of them.
 *
 * Nothing at all when nothing is set: an empty "Phone:" reads as a company
 * that forgot, which is worse than one that never mentioned it.
 */
export function CompanyContact({ contact, className, centered = false }: {
  contact: brand.CompanyContact | null | undefined;
  className?: string;
  centered?: boolean;
}) {
  if (!contact) return null;
  const address = branding.postalLine(contact);
  if (!address && !contact.phone && !contact.email) return null;
  return (
    <address aria-label="How to reach us" className={className ?? "text-xs not-italic text-ink-500"}>
      {address ? <span className="block">{address}</span> : null}
      {contact.phone || contact.email ? (
        <span className={centered ? "flex flex-wrap justify-center gap-x-3" : "flex flex-wrap gap-x-3"}>
          {contact.phone ? <Phone value={contact.phone} /> : null}
          {contact.email ? <a href={`mailto:${contact.email}`} className="hover:underline">{contact.email}</a> : null}
        </span>
      ) : null}
    </address>
  );
}
