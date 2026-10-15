/**
 * A PERSON'S OWN PHONE AND HOME ADDRESS, ON THE PHONE
 *
 * The same record `/me` keeps (M24, `POST /v1/me/contact`): the person's own
 * number and home address, sent whole each time with an empty box meaning
 * "take that off". It is the one thing in the app that is NOT queued. A
 * number that does not dial or a ZIP that is not a ZIP has to be told to the
 * person while they are holding the phone, in the server's own sentence, so
 * it is sent now or not at all, like the assistant and the card link. The
 * server is the only judge of what is acceptable: nothing here repeats its
 * rules, so the two cannot drift apart.
 */

/** What the server keeps: the latest version, or nothing yet. */
export interface OwnContactRecord {
  contact: {
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    savedAt: string;
  } | null;
  /** Newest first. What each save changed, for the office; the phone shows only the latest. */
  changes: { at: string; by: string | null; changes: { field: "phone" | "address"; before: string; after: string }[] }[];
}

/** The six boxes on the screen, as the person typed them. */
export interface OwnContactForm {
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
}

export const EMPTY_CONTACT_FORM: OwnContactForm = {
  phone: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "",
};

const KEYS = ["phone", "addressLine1", "addressLine2", "city", "state", "postalCode"] as const;

/** The boxes filled from what the server keeps. A phone is shown as a person dials it. */
export function contactFormOf(record: OwnContactRecord | null): OwnContactForm {
  const kept = record?.contact;
  if (!kept) return { ...EMPTY_CONTACT_FORM };
  return {
    phone: phoneWords(kept.phone),
    addressLine1: kept.addressLine1 ?? "",
    addressLine2: kept.addressLine2 ?? "",
    city: kept.city ?? "",
    state: kept.state ?? "",
    postalCode: kept.postalCode ?? "",
  };
}

/**
 * The body to send: every box, because the server takes the whole of it and
 * a box left out would be read as "leave it", where an empty one means
 * "take it off". Spaces trimmed; an empty box is null.
 */
export function contactBody(form: OwnContactForm): Record<(typeof KEYS)[number], string | null> {
  const out = {} as Record<(typeof KEYS)[number], string | null>;
  for (const key of KEYS) {
    const text = form[key].trim().replace(/\s+/g, " ");
    out[key] = text === "" ? null : text;
  }
  return out;
}

/** Whether the person changed anything, so Save can wait until they have. */
export function contactChanged(form: OwnContactForm, record: OwnContactRecord | null): boolean {
  const was = contactBody(contactFormOf(record));
  const now = contactBody(form);
  return KEYS.some((key) => was[key] !== now[key]);
}

/** `+15125550143` as `(512) 555-0143`; any other number as it is kept; none as an empty box. */
export function phoneWords(phone: string | null | undefined): string {
  if (!phone) return "";
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone;
}

/** The kept address on one line, or null when there is none, for the line above the boxes. */
export function addressLine(record: OwnContactRecord | null): string | null {
  const kept = record?.contact;
  if (!kept?.addressLine1) return null;
  const town = [kept.city, [kept.state, kept.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [kept.addressLine1, kept.addressLine2, town].filter(Boolean).join(", ");
}
