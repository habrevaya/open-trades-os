import { pgTable, pgEnum, uuid, text, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization } from "./tenancy";

/**
 * WHERE THE WORK COMES FROM, AS THE COMPANY NAMES IT
 *
 * Core's lead source catalogue is twenty one keys, closed on purpose: a text
 * column three CSRs type into is how "google", "Google" and "google ads" end
 * up as three rows and the one campaign that works ranks third. That argument
 * is right and it left a real gap. A company that buys leads from Angi AND
 * from Thumbtack sees both under "A lead marketplace", and a company running a
 * spring tune up push on Google Ads and an emergency campaign on the same
 * account sees one line called Google Ads.
 *
 * So there are two layers, and neither is free text a CSR types.
 *
 *   A CHANNEL is the company's own name for where work comes from ("Angi",
 *   "Google Ads", "The van"). It is a ROW, so it is picked from a list and
 *   renamed in one place, and each one maps to exactly one catalogue key so
 *   every report still rolls up to the twenty one. Seeded from the catalogue
 *   the first time anything reads the list; the company adds, renames and
 *   archives from there.
 *
 *   A CAMPAIGN sits under a channel ("Spring AC tune up" under Google Ads),
 *   with its dates, what it costs and the utm tag its links carry. Tracking
 *   numbers, spend, touches and jobs point at it.
 *
 * THIS IS NOT `marketing_campaign`, which is a text or email SEND to the
 * company's own list, and not `messaging_campaign`, which is a 10DLC carrier
 * registration. Three things called campaign is two too many, so this one is
 * `acquisition_campaign` in the schema and "tracking campaign" on screen: the
 * thing a tracking number and an ad budget belong to.
 *
 * Its own file rather than inside marketing.ts, because the job, the customer,
 * the phone number and the call all point at these two tables, and
 * marketing.ts already imports the job. A reference the other way would be an
 * import cycle between schema files.
 */

export const marketingChannel = pgTable("marketing_channel", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** What the office calls it. Shown on every picker and every report row. */
  name: text("name").notNull(),
  /**
   * The catalogue key this rolls up to. Checked against core's list on every
   * write, because a channel mapped to a key no report knows is spend and
   * leads that vanish from the roll up without anybody being told.
   */
  sourceKey: text("source_key").notNull(),
  /**
   * Archived rather than deleted. Last year's jobs still say they came from a
   * channel the company has stopped buying, and deleting it would move that
   * history into "not set".
   */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /**
   * One live channel per name. Two rows called "Google Ads" is the text
   * column problem again, one level up, and a picker showing the same word
   * twice is one somebody picks wrong from half the time.
   */
  nameIdx: uniqueIndex("marketing_channel_name_idx")
    .on(t.organizationId, sql`lower(${t.name})`)
    .where(sql`${t.archivedAt} is null`),
  sourceIdx: index("marketing_channel_source_idx").on(t.organizationId, t.sourceKey),
}));

/**
 * How a campaign's cost is counted, because not every channel sends a bill a
 * day.
 *
 *   `recorded`: whatever spend rows are entered or imported against it. The
 *   ordinary case for anything with an ads account.
 *
 *   `fixed`: one amount for the whole campaign (a radio spot, a run of yard
 *   signs, a home show stand), spread evenly over its days so a report over
 *   part of the campaign carries part of the cost.
 *
 *   `per_lead`: a price per lead (Local Services Ads, a marketplace), so the
 *   cost IS the lead count times the price and nobody has to type a spend row
 *   for every lead.
 */
export const acquisitionCostModel = pgEnum("acquisition_cost_model", ["recorded", "fixed", "per_lead"]);

export const acquisitionCampaign = pgTable("acquisition_campaign", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => marketingChannel.id),
  name: text("name").notNull(),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  costModel: acquisitionCostModel("cost_model").notNull().default("recorded"),
  /**
   * The fixed total under `fixed`, the price of one lead under `per_lead`, and
   * null under `recorded`, where the spend rows are the cost.
   */
  costAmount: money("cost_amount"),
  /** What the company meant to spend. A plan shown beside the cost, never added to it. */
  budget: money("budget"),
  /**
   * The tag its links carry, so a click arriving with this utm_campaign is
   * credited here without anybody matching it by hand. Unique while live,
   * for the reason the outbound campaign's is: two campaigns claiming one tag
   * means a touch is credited to whichever a query reads first.
   */
  utmCampaign: text("utm_campaign"),
  notes: text("notes"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  channelIdx: index("acquisition_campaign_channel_idx").on(t.organizationId, t.channelId),
  /** One live campaign per name, so a picker never offers two the same. */
  nameIdx: uniqueIndex("acquisition_campaign_name_idx")
    .on(t.organizationId, sql`lower(${t.name})`)
    .where(sql`${t.archivedAt} is null`),
  utmIdx: uniqueIndex("acquisition_campaign_utm_idx")
    .on(t.organizationId, sql`lower(${t.utmCampaign})`)
    .where(sql`${t.archivedAt} is null and ${t.utmCampaign} is not null`),
}));
