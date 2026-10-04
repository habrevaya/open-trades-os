import { pgTable, pgEnum, uuid, text, integer, jsonb, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { pk, timestamps, money } from "./_shared";
import { organization, user } from "./tenancy";
import { customer, property } from "./crm";
import { acquisitionCampaign } from "./acquisition";

/**
 * DIRECT MAIL: A MAILING, AND EVERY PIECE OF IT
 *
 * A mailing is an audience (the same rules a text campaign uses), a design,
 * and a tracking campaign under the direct mail channel whose tracking number
 * is printed on the card and to which every response is credited. The pieces
 * are history the moment it is sent: one row per customer the rules selected,
 * with the address it went to, its own code, what the printer said and every
 * visit to its address.
 */
export const mailCampaignState = pgEnum("mail_campaign_state", ["draft", "sending", "sent", "cancelled"]);
export const mailPieceState = pgEnum("mail_piece_state", ["pending", "sent", "skipped", "refused", "failed"]);

export const mailCampaign = pgTable("mail_campaign", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** `postcard` or `letter`. */
  kind: text("kind").notNull(),
  /** A postcard's size, as the printer names it. Null for a letter. */
  size: text("size"),
  /** Core's audience rules, checked on every write and again when it is sent. */
  audience: jsonb("audience").$type<Record<string, unknown>[]>().notNull(),
  /** The tracking campaign responses are credited to, and whose tracking number is printed. */
  acquisitionCampaignId: uuid("acquisition_campaign_id").notNull()
    .references(() => acquisitionCampaign.id, { onDelete: "restrict" }),
  front: text("front").notNull(),
  back: text("back"),
  /** What the personal address's page says to the person who arrives there. */
  landingHeadline: text("landing_headline"),
  landingBody: text("landing_body"),
  /** The company's own price for one piece, from its provider's price list. */
  pricePerPiece: money("price_per_piece"),
  state: mailCampaignState("state").notNull().default("draft"),
  /** The day the pieces were handed to the printer, which is the day the spend is recorded on. */
  sentOn: date("sent_on"),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("mail_campaign_org_idx").on(t.organizationId, t.createdAt),
}));

export const mailPiece = pgTable("mail_piece", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  mailCampaignId: uuid("mail_campaign_id").notNull().references(() => mailCampaign.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").references(() => property.id, { onDelete: "set null" }),
  /** The address as it was posted to, kept as written then. */
  name: text("name").notNull(),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  /** The piece's own code, which its personal address and QR code carry. */
  code: text("code").notNull(),
  status: mailPieceState("status").notNull().default("pending"),
  /** Core's skip reason, or the printer's words for a refusal. */
  reason: text("reason"),
  /** The printer's id for the piece. */
  providerId: text("provider_id"),
  expectedDeliveryOn: date("expected_delivery_on"),
  attempts: integer("attempts").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  firstVisitedAt: timestamp("first_visited_at", { withTimezone: true }),
  visits: integer("visits").notNull().default(0),
  ...timestamps,
}, (t) => ({
  /** One piece per customer per mailing, which is what makes a second press of Send post nobody twice. */
  recipientIdx: uniqueIndex("mail_piece_recipient_idx").on(t.mailCampaignId, t.customerId),
  /** The code is the whole of a personal address, found before anybody knows whose it is. */
  codeIdx: uniqueIndex("mail_piece_code_idx").on(t.code),
  pendingIdx: index("mail_piece_pending_idx").on(t.mailCampaignId, t.status),
}));
