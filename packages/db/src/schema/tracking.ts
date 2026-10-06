import { pgTable, uuid, text, integer, index, uniqueIndex, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization } from "./tenancy";
import { phoneNumber } from "./comms";

/**
 * THE WEBSITE, AND THE NUMBER IT SHOWED
 *
 * Dynamic number insertion is the only way a phone call from a website is
 * attributed to the visit that produced it. A visitor arrives from a Google
 * ad, the snippet on the company's own site swaps the phone number on the
 * page for one from a small pool, and that number is theirs for as long as
 * they are on the site. A call on it a minute later is the visit, and the
 * visit's tags and click id become the call's.
 *
 * A session is a LEASE on a pool number. One visitor at a time per number,
 * which the partial unique index enforces, so two visitors can never be shown
 * the same number at once and a call on it can only mean one of them.
 */
export const dniSession = pgTable("dni_session", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The first party visitor id the snippet keeps on the company's own site. */
  visitorId: text("visitor_id").notNull(),
  phoneNumberId: uuid("phone_number_id").notNull().references(() => phoneNumber.id, { onDelete: "cascade" }),
  /** The number shown, copied, because a pool number can be released and bought by somebody else. */
  e164: text("e164").notNull(),
  /**
   * How the visitor arrived, as the snippet read it from the landing page.
   * Copied onto the call's touch when a call on this number matches, through
   * the same parser a booking's landing page goes through.
   */
  landingQuery: text("landing_query"),
  referrer: text("referrer"),
  landingPath: text("landing_path"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  /** Moved forward every time the page says the visitor is still there. */
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * When the number went back to the pool: the visitor went quiet for longer
   * than the company's idle time. Set to the moment it lapsed, not the moment
   * somebody noticed, so the window a call is matched in is the real one.
   */
  releasedAt: timestamp("released_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /** One live lease per number. The thing that makes a call on it unambiguous. */
  liveIdx: uniqueIndex("dni_session_live_idx").on(t.organizationId, t.phoneNumberId)
    .where(sql`${t.releasedAt} is null`),
  visitorIdx: index("dni_session_visitor_idx").on(t.organizationId, t.visitorId, t.lastSeenAt),
  numberIdx: index("dni_session_number_idx").on(t.organizationId, t.phoneNumberId, t.assignedAt),
}));

/**
 * HOW OFTEN THE OPEN INTERNET HAS KNOCKED, PER KEY AND MINUTE
 *
 * The public endpoints (a touch from the snippet, a number for a visitor, a
 * form submission) have no login in front of them by design, so each counts
 * its callers here and refuses past a ceiling. A table rather than memory,
 * because a deployment on a serverless host runs a fresh process per burst
 * and a counter in one of them counts nothing.
 *
 * Not a tenant table. The key already names the company and the caller, the
 * row holds a count and nothing else, and the check runs before any tenant
 * context exists, because establishing which company the request is for is
 * part of what is being rate limited.
 */
export const publicRateLimit = pgTable("public_rate_limit", {
  key: text("key").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  hits: integer("hits").notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.key, t.windowStart] }),
  windowIdx: index("public_rate_limit_window_idx").on(t.windowStart),
}));
