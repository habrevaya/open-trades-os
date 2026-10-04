import { phoneAddress } from "../comms/index.js";

/**
 * HOW A CUSTOMER REACHES THE COMPANY
 *
 * The phone number, the email address and the postal address a company
 * prints on its own paper. The company record had none of the three, so every
 * proposal, invoice and statement went out with a name and a logo and no way
 * to call anybody, and the proposal page said so in the docs.
 *
 * All three are optional and each is printed only when it is set. A document
 * that prints "Phone:" with nothing after it reads as a company that forgot,
 * which is worse than a document that never mentions a phone.
 */
export interface CompanyContact {
  /** E.164 when it is a phone number, which is what a dialler and a `tel:` link need. */
  phone: string | null;
  /** Lower case. */
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export const NO_CONTACT: CompanyContact = {
  phone: null, email: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null,
};

export type ContactVerdict =
  | { ok: true; contact: CompanyContact }
  | { ok: false; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed, with runs of spaces closed up, and null for nothing at all. */
const tidy = (value: string | null | undefined): string | null => {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  return text === "" ? null : text;
};

/**
 * What somebody typed on the company form, as it will be stored.
 *
 * The phone goes through the same normaliser every text uses, so
 * "(512) 555-0143" is kept as `+15125550143` and prints and dials the same
 * everywhere. Something that is not a phone number at all is refused rather
 * than kept, because the one place it is read is a customer's document, and a
 * number nobody can dial is found by the customer rather than the owner.
 *
 * An address is either started or not. A street with no town is refused,
 * because printed on an invoice it is an address nobody can post a cheque to,
 * and the owner would not notice until one went missing.
 */
export function checkContact(input: {
  phone?: string | null | undefined;
  email?: string | null | undefined;
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  postalCode?: string | null | undefined;
}): ContactVerdict {
  const typedPhone = tidy(input.phone);
  let phone: string | null = null;
  if (typedPhone) {
    const e164 = phoneAddress(typedPhone);
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
      return { ok: false, reason: `${typedPhone} is not a phone number. Type it as you would dial it, for example (512) 555-0143.` };
    }
    phone = e164;
  }

  const typedEmail = tidy(input.email)?.toLowerCase() ?? null;
  if (typedEmail && (typedEmail.length > 254 || !EMAIL.test(typedEmail))) {
    return { ok: false, reason: `${typedEmail} is not an email address.` };
  }

  const address = {
    addressLine1: tidy(input.addressLine1),
    addressLine2: tidy(input.addressLine2),
    city: tidy(input.city),
    state: tidy(input.state),
    postalCode: tidy(input.postalCode),
  };
  for (const [key, value] of Object.entries(address)) {
    if (value && value.length > 120) return { ok: false, reason: `Keep each line of the address to a hundred and twenty characters (${key}).` };
  }
  const started = Object.values(address).some((value) => value !== null);
  if (started && (!address.addressLine1 || !address.city)) {
    return {
      ok: false,
      reason: "An address needs at least the street and the town. Leave every address box empty to print no address.",
    };
  }

  return { ok: true, contact: { phone, email: typedEmail, ...address } };
}

/**
 * A phone number as a person reads it on paper: `(512) 555-0143` for a North
 * American number, as stored for anything else, for the reason the web app's
 * `formatPhone` gives. Kept here because a PDF is drawn in core and cannot
 * reach the UI package.
 */
export function printedPhone(phone: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone.trim());
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone.trim();
}

/** The postal address on one line, or null when there is none. */
export function postalLine(contact: CompanyContact): string | null {
  if (!contact.addressLine1) return null;
  const town = [contact.city, [contact.state, contact.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  return [contact.addressLine1, contact.addressLine2, town].filter(Boolean).join(", ");
}

/**
 * What a document prints under the company's name, as at most two lines: the
 * postal address, then the phone and the email. Empty when nothing is set,
 * so a caller can test `length` rather than each field.
 */
export function contactLines(contact: CompanyContact): string[] {
  const reach = [contact.phone ? printedPhone(contact.phone) : null, contact.email]
    .filter((part): part is string => Boolean(part));
  return [postalLine(contact), reach.length > 0 ? reach.join("   ") : null]
    .filter((line): line is string => Boolean(line));
}
