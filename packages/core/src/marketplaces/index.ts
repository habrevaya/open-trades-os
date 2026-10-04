import { bareAddress, textFromHtml } from "../comms/index.js";

/**
 * THE LEAD MARKETPLACES: WHAT EACH ONE WILL LET US DO, AND THE EMAIL FALLBACK
 *
 * A trades company buys leads from three or four marketplaces at once, and
 * every one of them delivers differently. Some will push a lead to a URL the
 * moment it is sold and take a reply back through their own API; some will do
 * that only for a partner they have approved; one has no API for it at all.
 * What every one of them does is send the company an email saying a lead
 * arrived. So there are two ways in, and this module is the pure half of both:
 *
 *   WHAT EACH PLATFORM OFFERS, as data, so the setup screen can say "Thumbtack
 *   needs partner approval and then replies go back through it" rather than
 *   offering a switch that does nothing.
 *
 *   READING A LEAD NOTIFICATION EMAIL, for the platforms with no API access
 *   (or before the approval comes through). The company forwards those emails
 *   to its own lead inbox address and each becomes a lead offer, credited to
 *   the platform that sold it.
 *
 * THE EMAIL PARSER IS A READER OF LABELS, NOT OF LAYOUTS. Every platform
 * redesigns its emails, and a parser keyed on a table's third cell breaks the
 * week they do. What survives a redesign is the words: "Phone", "Customer
 * name", "Zip code" beside the value. So the parser looks for labels it knows
 * in front of values, takes the platform's own lead number when it can find
 * one, and when it cannot find a name and a way to reach the person it says
 * so rather than guessing. An email it cannot read is kept for a person to
 * read, never dropped.
 */

export type MarketplaceKey = "angi" | "thumbtack" | "yelp" | "nextdoor";

export interface MarketplaceSpec {
  key: MarketplaceKey;
  label: string;
  /**
   * How a lead can arrive other than by email.
   *
   *   `push`: the platform posts the whole lead to a URL.
   *   `notify_then_fetch`: the platform posts only an id, and the lead is read
   *   from its API with the company's token, which is also what makes a
   *   forged notice harmless.
   *   `none`: no API for leads at all.
   */
  api: "push" | "notify_then_fetch" | "none";
  /** Whether a reply written here can go back through the platform's own API. */
  replies: boolean;
  /** Whether the platform has to approve the operator as a partner before any of its API answers. */
  needsApproval: boolean;
  /** What the operator has to obtain, said plainly. */
  approval: string;
  /** Who its notification emails come from. Matched on the domain of the sender, or of a forwarded one. */
  emailDomains: readonly string[];
}

export const MARKETPLACES: Readonly<Record<MarketplaceKey, MarketplaceSpec>> = {
  angi: {
    key: "angi",
    label: "Angi",
    api: "push",
    replies: false,
    needsApproval: true,
    approval:
      "Angi delivers leads to a CRM only for partners in its CRM integration program, which Angi approves. "
      + "Until then, forward the lead emails Angi and HomeAdvisor send to the lead inbox address. Angi has no "
      + "API for writing back to a customer; call or text them from here.",
    emailDomains: ["angi.com", "angieslist.com", "homeadvisor.com", "angileads.com"],
  },
  thumbtack: {
    key: "thumbtack",
    label: "Thumbtack",
    api: "push",
    replies: true,
    needsApproval: true,
    approval:
      "Thumbtack's partner API is open only to partners Thumbtack approves. An approved partner gets a token "
      + "and registers this product's address for new leads and messages; replies written here then go back "
      + "through Thumbtack. Until then, forward Thumbtack's lead emails to the lead inbox address.",
    emailDomains: ["thumbtack.com"],
  },
  yelp: {
    key: "yelp",
    label: "Yelp",
    api: "notify_then_fetch",
    replies: true,
    needsApproval: true,
    approval:
      "Yelp's Leads API (Request a Quote) is open only to partners Yelp approves, and the business owner then "
      + "grants the partner access. Yelp posts only that something happened; the lead and its messages are read "
      + "from Yelp with the token, and replies go back through Yelp. Until then, forward Yelp's emails.",
    emailDomains: ["yelp.com", "messaging.yelp.com", "biz.yelp.com"],
  },
  nextdoor: {
    key: "nextdoor",
    label: "Nextdoor",
    api: "none",
    replies: false,
    needsApproval: false,
    approval:
      "Nextdoor has no API for a business's enquiries or messages; its public APIs are for advertising and "
      + "posting. Forward Nextdoor's notification emails to the lead inbox address, and answer on Nextdoor.",
    emailDomains: ["nextdoor.com", "hello.nextdoor.com", "is.email.nextdoor.com"],
  },
};

export const MARKETPLACE_KEYS = Object.keys(MARKETPLACES) as MarketplaceKey[];

export const isMarketplace = (value: string): value is MarketplaceKey =>
  (MARKETPLACE_KEYS as string[]).includes(value);

/* ------------------------------------------------------------ the inbox */

/**
 * THE COMPANY'S LEAD INBOX ADDRESS: `leads+TOKEN@` the domain its email
 * provider receives replies on.
 *
 * The same receiving domain the reply addresses use, so there is nothing new
 * to set up at the email provider, and a token rather than the company's name
 * so a stranger cannot aim forged leads at a company by guessing. The token is
 * also what decides the company when the email arrives, before anything else
 * about it is believed.
 */
export const LEAD_INBOX_PREFIX = "leads+";

export const leadInboxAddress = (token: string, domain: string): string =>
  `${LEAD_INBOX_PREFIX}${token}@${domain.trim().toLowerCase()}`;

/** The token from whichever recipient is the lead inbox, or null. */
export function leadInboxTokenIn(addresses: readonly string[], domain: string | null): string | null {
  for (const raw of addresses) {
    const address = bareAddress(raw).toLowerCase();
    const at = address.lastIndexOf("@");
    if (at < 0) continue;
    const local = address.slice(0, at);
    const host = address.slice(at + 1);
    if (domain && host !== domain.trim().toLowerCase()) continue;
    if (!local.startsWith(LEAD_INBOX_PREFIX)) continue;
    const token = local.slice(LEAD_INBOX_PREFIX.length);
    if (/^[a-z0-9_-]{16,64}$/.test(token)) return token;
  }
  return null;
}

/* ------------------------------------------------------- reading an email */

export interface LeadEmailInput {
  from: string;
  subject: string;
  text: string | null;
  html: string | null;
  /** Where a reply goes, which for Yelp is its relay address to the customer. */
  replyTo?: string | null | undefined;
}

export interface ParsedLead {
  /** The platform's own number for the lead, when the email carries one. */
  externalId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  service: string | null;
  notes: string | null;
  /** A notice that the customer wrote again, as opposed to a new lead. */
  kind: "lead" | "message";
}

export type LeadEmailVerdict =
  | { ok: true; platform: MarketplaceKey; lead: ParsedLead }
  | { ok: false; platform: MarketplaceKey | null; reason: string };

const domainOf = (address: string): string => {
  const bare = bareAddress(address).toLowerCase();
  return bare.slice(bare.lastIndexOf("@") + 1);
};

const belongsTo = (domain: string, spec: MarketplaceSpec) =>
  spec.emailDomains.some((d) => domain === d || domain.endsWith(`.${d}`));

/**
 * Which platform sent it: the sender, or when somebody forwarded it by hand,
 * the "From:" line of the forwarded message in the body.
 */
export function detectPlatform(input: { from: string; text: string }): MarketplaceKey | null {
  const candidates = [input.from];
  for (const match of input.text.matchAll(/^\s*>?\s*From:\s*(.+)$/gim)) candidates.push(match[1]!);
  for (const candidate of candidates) {
    const domain = domainOf(candidate);
    for (const spec of Object.values(MARKETPLACES)) {
      if (belongsTo(domain, spec)) return spec.key;
    }
  }
  return null;
}

/** The labels a value is found beside, per field, most specific first. */
const LABELS: Record<"name" | "phone" | "email" | "address" | "city" | "state" | "postalCode" | "service" | "notes" | "id", readonly string[]> = {
  name: ["customer name", "contact name", "homeowner name", "client name", "full name", "name", "customer", "homeowner"],
  phone: ["customer phone", "phone number", "primary phone", "mobile phone", "cell phone", "phone", "mobile", "cell", "telephone"],
  email: ["customer email", "email address", "e-mail", "email"],
  address: ["service address", "street address", "job address", "property address", "address", "street", "location"],
  city: ["city"],
  state: ["state"],
  postalCode: ["zip code", "postal code", "zipcode", "zip"],
  service: ["service requested", "service needed", "type of service", "job type", "service", "task", "category", "project type", "looking for", "request"],
  notes: ["project details", "additional details", "additional information", "comments", "details", "description", "message", "notes"],
  id: ["lead id", "lead number", "lead #", "request id", "request number", "request #", "sr number", "sr #", "reference number", "job id"],
};

const PHONE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Lines, trimmed, with quoting marks and stray markup characters taken off. */
function linesOf(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.replace(/^\s*>+\s?/, "").replace(/[*_]{1,2}/g, "").trim());
}

/**
 * The value beside a label: "Phone: (512) 555 0100" on one line, or the label
 * alone on one line and the value on the next, which is how an HTML table
 * comes out once it is text.
 */
function labelled(lines: readonly string[], labels: readonly string[]): string | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");
    const inline = new RegExp(`^${escaped}\\s*[:\\-]\\s*(.+)$`, "i");
    const alone = new RegExp(`^${escaped}\\s*:?$`, "i");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const hit = inline.exec(line);
      if (hit && hit[1]!.trim() !== "") return hit[1]!.trim();
      if (alone.test(line)) {
        const next = lines.slice(i + 1).find((l) => l !== "");
        if (next && !/:\s*$/.test(next)) return next;
      }
    }
  }
  return null;
}

/** "Austin, TX 78704" into its parts. */
function cityLine(value: string): { city: string; state: string; postalCode: string } | null {
  const match = /^([A-Za-z .'-]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(value.trim());
  return match ? { city: match[1]!.trim(), state: match[2]!.toUpperCase(), postalCode: match[3]! } : null;
}

const phoneIn = (value: string | null): string | null => {
  if (!value) return null;
  const match = PHONE.exec(value);
  return match ? `+1${match[1]}${match[2]}${match[3]}` : null;
};

/** The platform's own number for the lead, from its links first and its labels second. */
function externalIdIn(platform: MarketplaceKey, body: string, lines: readonly string[]): string | null {
  const patterns: Record<MarketplaceKey, RegExp[]> = {
    angi: [/(?:leadOid|leadId|lead_id|srOid|srId)=([0-9]{4,})/i, /\/leads?\/([0-9]{4,})/i],
    thumbtack: [/thumbtack\.com\/[^\s"'<>]*?(?:leads?|requests?|negotiations?|messages?)\/([0-9A-Za-z_-]{6,})/i],
    yelp: [/yelp\.com\/[^\s"'<>]*?leads?\/([0-9A-Za-z_-]{6,})/i, /[?&]lead_id=([0-9A-Za-z_-]{6,})/i],
    nextdoor: [/nextdoor\.com\/[^\s"'<>]*?(?:messages?|inbox|conversations?)\/([0-9A-Za-z_-]{6,})/i],
  };
  for (const pattern of patterns[platform]) {
    const match = pattern.exec(body);
    if (match) return match[1]!;
  }
  const labelledId = labelled(lines, LABELS.id);
  const token = labelledId ? /([0-9A-Za-z_-]{4,})/.exec(labelledId) : null;
  return token ? token[1]! : null;
}

/** A name out of a subject line such as "New lead from Dana Ruiz" or "Dana Ruiz sent you a message". */
function nameFromSubject(subject: string): string | null {
  const patterns = [
    /(?:new\s+)?(?:lead|request|quote request|message|enquiry|inquiry)\s+from\s+([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3})/i,
    /^([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3})\s+(?:sent you|has sent|wants|is looking|requested|messaged)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(subject.trim());
    if (match) return match[1]!.trim();
  }
  return null;
}

/** The refusal for a lead nobody can be reached on. */
export const noReach = (platform: MarketplaceKey, name: string): string =>
  `This ${MARKETPLACES[platform].label} email names ${name} and gives no phone number or email, so there is nobody to call. `
  + `Open the lead on ${MARKETPLACES[platform].label}.`;

/** Whether the email says the customer wrote again rather than that a lead arrived. */
const MESSAGE_SUBJECT = /\b(new message|sent you a message|replied|has replied|wrote back|new reply)\b/i;

/**
 * Read one lead notification email.
 *
 * The rule a webhook lead is held to, applied here too: a name and some way to
 * reach the person, or it is not a lead. A Yelp email carries no phone and
 * often no address, and its Reply-To is Yelp's relay to the customer, which is
 * a real way to reach them and is used as their email.
 */
export function parseLeadEmail(input: LeadEmailInput): LeadEmailVerdict {
  const text = (input.text && input.text.trim() !== "" ? input.text : input.html ? textFromHtml(input.html) : "") ?? "";
  const body = `${text}\n${input.html ?? ""}`;
  const platform = detectPlatform({ from: input.from, text });
  if (!platform) {
    return {
      ok: false, platform: null,
      reason: "This did not come from Angi, HomeAdvisor, Thumbtack, Yelp or Nextdoor, so it was kept for somebody to read rather than made into a lead.",
    };
  }
  const lines = linesOf(text);
  const kind: ParsedLead["kind"] = MESSAGE_SUBJECT.test(input.subject) ? "message" : "lead";

  const name = labelled(lines, LABELS.name) ?? nameFromSubject(input.subject);
  let phone = phoneIn(labelled(lines, LABELS.phone));
  const ownDomains = MARKETPLACES[platform].emailDomains;
  const isOwn = (address: string) => ownDomains.some((d) => domainOf(address) === d || domainOf(address).endsWith(`.${d}`));
  const labelledEmail = labelled(lines, LABELS.email);
  let email = labelledEmail ? EMAIL.exec(labelledEmail)?.[0]?.toLowerCase() ?? null : null;
  if (email && isOwn(email) && !/relay|reply|messaging/.test(email)) email = null;
  /** Yelp and Thumbtack relay a reply to the customer through their own address, which reaches the person. */
  if (!email && input.replyTo) {
    const relay = bareAddress(input.replyTo).toLowerCase();
    if (relay.includes("@") && isOwn(relay) && !/^(no-?reply|donotreply)@/.test(relay)) email = relay;
  }
  if (!phone) {
    /** An unlabelled number in a lead email is the customer's more often than not, unless it is the platform's own help line. */
    const candidates = lines.filter((l) => !/support|help|customer service|call us|questions/i.test(l));
    for (const line of candidates) {
      phone = phoneIn(line);
      if (phone) break;
    }
  }

  let addressLine1 = labelled(lines, LABELS.address);
  let city = labelled(lines, LABELS.city);
  let state = labelled(lines, LABELS.state);
  let postalCode = labelled(lines, LABELS.postalCode)?.match(/\d{5}(?:-\d{4})?/)?.[0] ?? null;
  if (addressLine1) {
    /** "12 Pecan St, Austin, TX 78704" on one line. */
    const parts = addressLine1.split(",").map((p) => p.trim());
    if (parts.length >= 3) {
      const tail = cityLine(`${parts[parts.length - 2]}, ${parts[parts.length - 1]}`);
      if (tail) {
        addressLine1 = parts.slice(0, -2).join(", ");
        city ??= tail.city; state ??= tail.state; postalCode ??= tail.postalCode;
      }
    } else {
      const whole = cityLine(addressLine1);
      if (whole) {
        addressLine1 = null;
        city ??= whole.city; state ??= whole.state; postalCode ??= whole.postalCode;
      }
    }
  }
  if (!city || !state || !postalCode) {
    for (const line of lines) {
      const found = cityLine(line);
      if (found) {
        city ??= found.city; state ??= found.state; postalCode ??= found.postalCode;
        break;
      }
    }
  }
  if (state && !/^[A-Za-z]{2}$/.test(state.trim())) state = null;

  if (!name) {
    return {
      ok: false, platform,
      reason: `This ${MARKETPLACES[platform].label} email carries no name this could find, so it was kept for somebody to read rather than made into a lead with nobody on it.`,
    };
  }
  /**
   * A notice that the customer wrote again needs no number: it belongs on a
   * lead already here, which has one. Whether there is such a lead is the
   * service's question, and it applies this rule itself when there is not.
   */
  if (!phone && !email && kind === "lead") {
    return { ok: false, platform, reason: noReach(platform, name) };
  }

  const clip = (value: string | null, max: number) => (value ? value.slice(0, max) : null);
  return {
    ok: true,
    platform,
    lead: {
      externalId: externalIdIn(platform, body, lines),
      name: name.slice(0, 200),
      phone,
      email,
      addressLine1: clip(addressLine1, 200),
      city: clip(city, 100),
      state: state ? state.trim().toUpperCase() : null,
      postalCode,
      service: clip(labelled(lines, LABELS.service), 200),
      notes: clip(labelled(lines, LABELS.notes), 2000),
      kind,
    },
  };
}
