import { firstNameOf } from "../campaign/index.js";
import * as m from "../money/index.js";
import { trimTrailingSlashes } from "../url.js";

/**
 * DIRECT MAIL: A POSTCARD TO THE LIST YOU ALREADY OWN, AND KNOWING WHAT IT DID
 *
 * Direct mail is the channel trades companies spend on and measure least. A
 * thousand postcards go out, the phone rings a bit more that month, and
 * nobody can say whether it was the postcard. Two things make it measurable,
 * and both are on every piece this product sends:
 *
 *   A TRACKING NUMBER. The mail campaign is a tracking campaign under the
 *   direct mail channel, and the number on the card is that campaign's
 *   tracking number, so every call to it is credited to the mailing by the
 *   call tracking that already exists.
 *
 *   A PERSONAL ADDRESS (a PURL) and its QR code. Every piece carries its own
 *   short code, so a visit to it is not "somebody from the mailing" but this
 *   customer, from this piece, on this day. The visit is recorded as a touch
 *   on the mail campaign against the customer it was addressed to, and the
 *   job they book afterwards is credited to it through the same `creditWork`
 *   every other path uses.
 *
 * The cost is the price per piece times the pieces that went, recorded as
 * spend on the campaign's day, so the funnel compares it with what came back
 * like any other channel.
 *
 * WHAT THIS MODULE DECIDES, purely: what may be printed (the same closed list
 * of merge fields campaigns use, plus the mail's own), that every value
 * printed is escaped, whether an address can be posted, what a code looks
 * like, and what a mailing costs. Sending is the API's, through the mail
 * provider seam.
 */

export type MailKind = "postcard" | "letter";
export const MAIL_KINDS: readonly MailKind[] = ["postcard", "letter"];

/** The postcard sizes the provider prints. A letter is a folded US letter page. */
export const POSTCARD_SIZES = ["4x6", "6x9", "6x11"] as const;
export type PostcardSize = (typeof POSTCARD_SIZES)[number];

export type MailCampaignState = "draft" | "sending" | "sent" | "cancelled";
export const MAIL_CAMPAIGN_STATES: readonly MailCampaignState[] = ["draft", "sending", "sent", "cancelled"];

const TRANSITIONS: Readonly<Record<MailCampaignState, readonly MailCampaignState[]>> = {
  draft: ["sending", "cancelled"],
  /** A mailing part sent can be stopped; the pieces already with the printer are not called back. */
  sending: ["sent", "cancelled"],
  sent: [],
  cancelled: [],
};

export const canTransition = (from: MailCampaignState, to: MailCampaignState): boolean =>
  TRANSITIONS[from].includes(to);

/** Where one piece stands. */
export type MailPieceState = "pending" | "sent" | "skipped" | "refused" | "failed";

export type SkipReason = "no_address" | "incomplete_address";

export const SKIP_WORDS: Readonly<Record<SkipReason, string>> = {
  no_address: "No address on file to post it to.",
  incomplete_address: "The address on file is missing a street, a town, a state or a ZIP code, so the post office could not deliver it.",
};

/* -------------------------------------------------------------- printing */

/**
 * What a mail design may say about the person and the piece. The campaigns'
 * four, so a word means the same on a text and a postcard, and the mail's own
 * three: its personal address, the number to ring, and the code on it.
 */
export const MAIL_FIELDS = [
  { key: "customer.firstName", label: "Their first name", example: "Maria" },
  { key: "customer.name", label: "Their name as it is on the account", example: "Maria Lopez" },
  { key: "company.name", label: "Your company's name", example: "Hartley Heating and Air" },
  { key: "company.phone", label: "Your main number", example: "(512) 555-0100" },
  { key: "mail.url", label: "Their own web address for this mailing", example: "https://you.example/m/k7p2x9qrta" },
  { key: "mail.phone", label: "The mailing's tracking number", example: "(512) 555-0199" },
  { key: "mail.code", label: "The code on their piece", example: "k7p2x9qrta" },
] as const;

const KNOWN = new Set<string>(MAIL_FIELDS.map((f) => f.key));
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** The most a design may be, which is far more than any card needs and short of a pasted page of base64. */
export const MAX_DESIGN = 100_000;

export interface DesignInput {
  kind: MailKind;
  /** The front of a postcard, or the letter itself. HTML, as the printer takes it. */
  front: string;
  /** The back of a postcard. A letter has none. */
  back: string | null;
}

export type DesignVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a design can be printed.
 *
 * An unknown placeholder is refused when the campaign is saved, because the
 * renderer turns one into nothing and "Hi ," on a thousand cards is paid for
 * by the piece. The personal address has to be printed somewhere a person can
 * type it, not only in the QR code, because not everybody points a camera at
 * a postcard, and a mailing whose response nobody can tie back is the thing
 * this whole module exists to stop.
 */
export function checkDesign(input: DesignInput): DesignVerdict {
  const front = input.front.trim();
  const back = (input.back ?? "").trim();
  if (front === "") return { ok: false, reason: input.kind === "letter" ? "Write the letter." : "Design the front of the card." };
  if (input.kind === "postcard" && back === "") return { ok: false, reason: "Design the back of the card, where the address goes." };
  if (input.kind === "letter" && back !== "") return { ok: false, reason: "A letter has one side to design. Put everything in the letter." };
  if (front.length + back.length > MAX_DESIGN) {
    return { ok: false, reason: "The design is longer than any card needs. Link images rather than pasting them in." };
  }
  const used = [...`${front}\n${back}`.matchAll(PLACEHOLDER)].map((match) => match[1]!);
  const unknown = [...new Set(used.filter((name) => !KNOWN.has(name)))];
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `${unknown.map((u) => `{{ ${u} }}`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not something this can fill in, and would print as nothing. `
        + `It can fill in: ${MAIL_FIELDS.map((f) => `{{ ${f.key} }}`).join(", ")}.`,
    };
  }
  if (!used.includes("mail.url")) {
    return {
      ok: false,
      reason: "Print {{ mail.url }} somewhere on it. It is each person's own address, and it is how a visit from this card is told apart from everybody else's.",
    };
  }
  return { ok: true };
}

/** HTML's five, so a customer called "Lopez & Sons" prints as that and not as broken markup. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The values one piece is printed with, already escaped.
 *
 * Escaped here rather than by the renderer, which is the one renderer every
 * text and email goes through and is right not to escape a text message. A
 * design is HTML and a customer's name is not, so every value that goes into
 * one goes through this first.
 */
export function mailScope(input: {
  customerName: string;
  companyName: string;
  companyPhone: string | null;
  url: string;
  phone: string | null;
  code: string;
}): Record<string, unknown> {
  const e = (value: string | null) => escapeHtml(value ?? "");
  return {
    customer: { firstName: e(firstNameOf(input.customerName)), name: e(input.customerName.trim()) },
    company: { name: e(input.companyName), phone: e(input.companyPhone) },
    mail: { url: e(input.url), phone: e(input.phone ?? input.companyPhone), code: e(input.code) },
  };
}

/** A US phone number written the way a card prints it: (512) 555-0199. */
export function printedPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164.trim());
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

/* --------------------------------------------------------------- addresses */

export interface MailAddress {
  name: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

/**
 * Whether an address can be posted, in the United States, which is where the
 * provider this product speaks to delivers. Checked here so a piece that
 * cannot arrive is skipped with the reason before it is paid for.
 */
export function checkAddress(address: MailAddress): { ok: true } | { ok: false; reason: SkipReason } {
  const has = (value: string | null) => typeof value === "string" && value.trim() !== "";
  if (!has(address.line1) && !has(address.city) && !has(address.postalCode)) return { ok: false, reason: "no_address" };
  if (!has(address.line1) || !has(address.city)) return { ok: false, reason: "incomplete_address" };
  if (!/^[A-Za-z]{2}$/.test((address.state ?? "").trim())) return { ok: false, reason: "incomplete_address" };
  if (!/^\d{5}(-\d{4})?$/.test((address.postalCode ?? "").trim())) return { ok: false, reason: "incomplete_address" };
  return { ok: true };
}

/* ------------------------------------------------------- do not mail list */

/**
 * THE DO NOT MAIL LIST
 *
 * Somebody rings and says "stop sending me postcards", or a landlord writes
 * that nobody at the building wants them. A customer can be put on the list
 * (they are then never mailed, wherever they move to, and the address they
 * were listed at is held as well) or an address can be typed in (whoever lives
 * there is never mailed). Every mailing checks the list twice: when it freezes
 * who it goes to, and again as each piece is about to be handed to the printer,
 * so a name added after the button was pressed still stops the card.
 *
 * ADDRESSES ARE COMPARED AS THE POST OFFICE WOULD, NOT AS TYPED. "12 Oak
 * Street" and "12 OAK ST." are one door, and so are "12 Oak St Apt 4" and
 * "12 Oak St, #4". A listed address with no unit is the whole building: a
 * note from one flat of a block is a no for the block until somebody says
 * which flat, because posting a card to a person who asked not to get one
 * costs far more than not posting one to their neighbour. A listed address
 * with a unit holds that flat only.
 */

const STREET_WORDS: Readonly<Record<string, string>> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", lane: "ln", boulevard: "blvd", court: "ct",
  circle: "cir", place: "pl", parkway: "pkwy", highway: "hwy", terrace: "ter", trail: "trl", way: "way",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  apartment: "apt", suite: "ste", building: "bldg", floor: "fl", room: "rm",
};

/** The words that say what follows is a unit inside the building. */
const UNIT_WORDS: ReadonlySet<string> = new Set(["apt", "ste", "unit", "bldg", "fl", "rm", "#"]);

const tokens = (text: string | null | undefined): string[] =>
  (text ?? "").toLowerCase().replace(/#/g, " # ").replace(/[^a-z0-9#]+/g, " ").trim().split(/\s+/).filter(Boolean)
    .map((t) => STREET_WORDS[t] ?? t);

/**
 * Where a postal address is, for comparing: the building (street line and ZIP,
 * abbreviated and with the unit peeled off) and the unit ("" for none). Null
 * for an address that cannot be posted to, which no list entry can name.
 */
export function addressKeys(address: Omit<MailAddress, "name">): { building: string; unit: string } | null {
  if (!checkAddress({ name: "", ...address }).ok) return null;
  const street = tokens(address.line1);
  /** A unit written at the end of the street line ("12 Oak St Apt 4") is the unit, not part of the street. */
  let unit = tokens(address.line2).filter((t) => t !== "#" && !UNIT_WORDS.has(t));
  const at = street.findIndex((t, i) => i > 1 && UNIT_WORDS.has(t));
  const peeled = at === -1 ? [] : street.splice(at).filter((t) => t !== "#" && !UNIT_WORDS.has(t));
  if (unit.length === 0) unit = peeled;
  return { building: `${street.join(" ")}|${(address.postalCode ?? "").trim().slice(0, 5)}`, unit: unit.join(" ") };
}

/** A name on the list: a customer, an address, or both. `building` is null for a customer listed without a postable address. */
export interface DoNotMailEntry {
  id: string;
  customerId: string | null;
  building: string | null;
  unit: string;
  /** Who it is for, as written when it was added. */
  name: string | null;
  /** Why, in the words of whoever added it. */
  reason: string | null;
}

/** The entry that stops this piece, if any: the customer first, then the door. */
export function doNotMailEntryFor(
  entries: readonly DoNotMailEntry[], piece: { customerId: string | null; address: Omit<MailAddress, "name"> },
): { entry: DoNotMailEntry; by: "customer" | "address" } | null {
  if (piece.customerId) {
    const person = entries.find((e) => e.customerId === piece.customerId);
    if (person) return { entry: person, by: "customer" };
  }
  const keys = addressKeys(piece.address);
  if (!keys) return null;
  const door = entries.find((e) => e.building === keys.building && (e.unit === "" || e.unit === keys.unit));
  return door ? { entry: door, by: "address" } : null;
}

/**
 * The reason a piece was skipped, in words for the mailing's page: that it is
 * on the list, who or where, why when somebody wrote it, and how to change it.
 */
export function doNotMailWords(hit: { entry: DoNotMailEntry; by: "customer" | "address" }, address: string): string {
  const who = hit.by === "customer" ? (hit.entry.name ? `${hit.entry.name} is` : "This customer is") : `${address} is`;
  const why = hit.entry.reason?.trim() ? `: ${hit.entry.reason.trim()}` : "";
  return `Not posted. ${who} on your do not mail list${why}. Take them off the list on the Direct mail page to mail them.`;
}

/* ------------------------------------------------------------------- codes */

/**
 * The letters a piece's code is made of. No 0 and o, no 1, l and i: a code is
 * read off card stock by somebody typing it on a phone, and a code that can
 * be misread is a visit credited to nobody.
 */
export const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const CODE_LENGTH = 10;

export const isMailCode = (value: string): boolean =>
  value.length === CODE_LENGTH && [...value].every((c) => CODE_ALPHABET.includes(c));

/** A code from random bytes, one letter per byte, rejecting the bytes that would bias it. */
export function codeFrom(bytes: Uint8Array): string | null {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = "";
  for (const byte of bytes) {
    if (byte >= limit) continue;
    out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    if (out.length === CODE_LENGTH) return out;
  }
  return null;
}

/** The personal address a piece prints: the deployment's own public address and the code. */
export const mailUrl = (base: string, code: string): string => `${trimTrailingSlashes(base)}/m/${code}`;

/* -------------------------------------------------------------------- cost */

/**
 * What a mailing cost: the price per piece times the pieces the printer took.
 *
 * The price is the company's own figure from its provider's price list, typed
 * on the campaign, because the provider's API does not say what a piece cost.
 * Postage included or not is whatever that figure includes.
 */
export function mailCost(pieces: number, pricePerPiece: string | null): string {
  if (!pricePerPiece || pieces <= 0) return "0.0000";
  return m.toString(m.multiply(m.money(pricePerPiece), String(pieces)));
}
