import type { Database } from "@opentradesos/db";
import * as templates from "./message-templates";
import type { TemplateInput } from "./message-templates";
import { render } from "../lib/render";

/**
 * WHAT THE CUSTOMER READS WHEN THEY ARE GIVEN LONGER (M07)
 *
 * Giving a customer longer to answer an estimate can tell them so. The words
 * are a message template per channel, so a company can put them its own way,
 * and the product's own wording is used when a company never wrote any:
 * telling a customer their price is held must not fail because nobody opened a
 * settings screen.
 *
 * THE LINE IS A NOTE, NOT THE WHOLE MESSAGE. The message itself is the
 * estimate send's (the company's name, what the estimate is and the link to
 * approve it), with this line above the link, so the customer is told the new
 * date and has a link that works in the same message.
 */

export const EXTENDED_CODES = { sms: "estimate_extended.sms", email: "estimate_extended.email" } as const;

/** What the words may use. */
export const EXTENDED_VARIABLES = [
  "customer.firstName", "company.name", "estimate.number", "estimate.title",
  "estimate.expiresOn", "estimate.previousExpiresOn",
] as const;

export const DEFAULT_EXTENDED: readonly (TemplateInput & { code: typeof EXTENDED_CODES[keyof typeof EXTENDED_CODES] })[] = [
  {
    code: EXTENDED_CODES.sms, name: "Estimate given longer (text)", channel: "sms",
    body: "Good news: we are holding your price until {{ estimate.expiresOn }}.",
    variables: [...EXTENDED_VARIABLES],
  },
  {
    code: EXTENDED_CODES.email, name: "Estimate given longer (email)", channel: "email",
    subject: "Your estimate is held until {{ estimate.expiresOn }}",
    body: "We are holding the price on your estimate until {{ estimate.expiresOn }}. Nothing else has changed.",
    variables: [...EXTENDED_VARIABLES],
  },
];

const longDay = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

/** What the placeholders read for one estimate. Dates are said as a customer says them. */
export function extendedScope(input: {
  customerName: string; organizationName: string; number: number; title: string | null;
  expiresOn: string; previousExpiresOn: string;
}): Record<string, unknown> {
  return {
    customer: { firstName: input.customerName.split(" ")[0] || input.customerName, name: input.customerName },
    company: { name: input.organizationName },
    estimate: {
      number: input.number, title: input.title ?? "",
      expiresOn: longDay(input.expiresOn), previousExpiresOn: longDay(input.previousExpiresOn),
    },
  };
}

export interface ExtendedNotice { text: string; email: { subject: string; body: string } }

/**
 * The note in the company's words, or the product's own when a template is
 * missing or switched off.
 */
export async function renderExtended(
  tx: Database, organizationId: string, scope: Record<string, unknown>,
): Promise<ExtendedNotice> {
  const [text, mail] = await Promise.all([
    templates.renderWithin(tx, organizationId, EXTENDED_CODES.sms, scope),
    templates.renderWithin(tx, organizationId, EXTENDED_CODES.email, scope),
  ]);
  const [defaultText, defaultMail] = DEFAULT_EXTENDED;
  return {
    text: (text?.body ?? render(defaultText!.body, scope)).trim(),
    email: {
      subject: (mail?.subject ?? render(defaultMail!.subject ?? "", scope)).trim(),
      body: (mail?.body ?? render(defaultMail!.body, scope)).trim(),
    },
  };
}
