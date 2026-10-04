import { randomBytes, createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { campaign as cp, comms, resolveMembership, SYSTEM_USER_ID, type Actor, type Permission, type RoleId } from "@opentradesos/core";
import * as commsSend from "./comms-send";
import * as email from "./email";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { render } from "../lib/render";
import { REVENUE_SQL } from "./marketing";
import { senderFor } from "./phone-numbers";

/**
 * SENDING TO THE LIST THE COMPANY ALREADY OWNS
 *
 * M19 could measure a channel and could not use one. Everything in
 * `services/marketing.ts` is about traffic somebody else sent: a touch
 * arrives, it is parsed, it is credited, and at the end of the quarter an
 * owner learns what Google cost per booked job. The list a trades company
 * owns outright, eleven years of customers with addresses and equipment and
 * service history, could not be contacted from this product at all.
 *
 * `campaign:read` and `campaign:write` were on the owner's and the marketing
 * manager's role from the first migration and checked by nothing, and the
 * guard test that finds those excused them with "M19 measures; it does not
 * yet send a campaign". This is that line coming out.
 *
 * FOUR THINGS HAD TO BE TRUE BEFORE A SEND WAS POSSIBLE, and each had been
 * false in a way that read as solved:
 *
 *   NOBODY COULD RECORD CONSENT, until the batch before this one.
 *   `canSend` requires a granted row for anything marketing and implies
 *   nothing, so every marketing message this product could have sent was
 *   refused permanently while the on my way text went out fine.
 *
 *   NOTHING SERVED AN UNSUBSCRIBE. `email.queue` has refused marketing with
 *   no unsubscribe URL since it was written, which is CAN-SPAM and the Gmail
 *   and Yahoo bulk rules, and this product had no page to point at. The gate
 *   was real and the only way through it was a URL hosted somewhere that
 *   could not write a suppression into this database. `unsubscribe.ts` is
 *   that page.
 *
 *   THE QUIET HOURS CHECK HAD NEVER FIRED. `canSend` refuses `quiet_hours`
 *   only when a caller passes a window and a local hour, and no caller
 *   passed either. See `comms-send.quietHoursFor`.
 *
 *   THE CARRIER'S THROUGHPUT WAS WRITTEN AND IGNORED.
 *   `messaging_campaign.messages_per_second` and `.daily_cap` carried the
 *   comment "so the sender can pace rather than fail" and no sender read
 *   them. A send that ignores a daily cap is not throttled by the carrier,
 *   it is rejected, and rejected marketing counts against the number.
 *
 * THE AUDIENCE IS SELECTED ONCE, AT SEND TIME, AND FROZEN.
 *
 * `preview` runs the rules and counts. `send` runs them again and writes one
 * `campaign_recipient` row per person, including the ones it will not send
 * to, and from that moment the rules are history rather than the definition
 * of who got it. Recomputing the audience to answer "who did this go to"
 * would answer a different question every month and call it the same report.
 */

/* ------------------------------------------------------------ the audience */

/**
 * The SQL for one rule, as a clause against `customer c`.
 *
 * EVERY PARAMETER GOES THROUGH A PLACEHOLDER. A rule's day count has already
 * been bounded by `checkAudience`, and interpolating it anyway would mean the
 * safety of this query depended on validation in another package staying
 * correct. The tenant boundary here is row level security rather than these
 * clauses, which is why none of them repeats `organization_id`: a clause that
 * looks like the protection is how the real protection stops being checked.
 */
export function clauseFor(rule: cp.AudienceRule) {
  switch (rule.kind) {
    case "no_job_since":
      /**
       * The most recent completion, not "no completion inside the window".
       * The second form is also true of somebody who has never been served,
       * and a win back offer to a lead who never bought is a different
       * campaign. `max(completed_at)` makes the requirement for one completed
       * job part of the comparison rather than a second clause that could be
       * dropped.
       */
      return sql`(
        select max(j.completed_at) from public.job j
        where j.customer_id = c.id and j.deleted_at is null
      ) < now() - make_interval(days => ${rule.days}::int)`;

    case "served_at_least_once":
      return sql`exists (
        select 1 from public.job j
        where j.customer_id = c.id and j.deleted_at is null and j.completed_at is not null
      )`;

    case "equipment_older_than":
      /**
       * Through `customer_property`, because equipment hangs off a property
       * and a property can have an owner, a tenant and a manager. All three
       * are plausible recipients of a replacement offer and which one the
       * company should talk to is not something this rule can decide, so it
       * matches any of them and leaves the choice to whoever wrote the list.
       */
      return sql`exists (
        select 1 from public.equipment e
        join public.customer_property cpr on cpr.property_id = e.property_id
        where cpr.customer_id = c.id
          and e.deleted_at is null
          and e.active
          and e.installed_on is not null
          and e.installed_on < current_date - make_interval(years => ${rule.years}::int)
          ${rule.category ? sql`and e.category = ${rule.category}` : sql``}
      )`;

    case "agreement_ending_within":
      /**
       * Still running and ending soon. An agreement that ended last week is
       * `agreement_lapsed`, and putting it here would mean a renewal campaign
       * went to people whose renewal date has passed with a message telling
       * them it has not.
       */
      return sql`exists (
        select 1 from public.agreement a
        where a.customer_id = c.id and a.deleted_at is null
          and a.status in ('active', 'past_due')
          and a.ends_on is not null
          and a.ends_on >= current_date
          and a.ends_on <= current_date + make_interval(days => ${rule.days}::int)
      )`;

    case "agreement_lapsed":
      return sql`exists (
        select 1 from public.agreement a
        where a.customer_id = c.id and a.deleted_at is null
          and a.status in ('lapsed', 'cancelled')
      )`;

    case "no_agreement":
      /**
       * NEVER HELD ONE, with no status filter at all, and the version with one
       * was wrong in a way a test caught.
       *
       * Filtering to the live statuses makes this "holds no agreement RIGHT
       * NOW", which quietly includes everybody whose plan lapsed, was
       * cancelled, or ran its full term and completed. Those three are not
       * customers who never bought a plan, and the message for them is a
       * renewal rather than an introduction: an upsell email saying "have you
       * considered a maintenance plan" to somebody who had one for six years
       * reads as a company that does not know who its customers are.
       *
       * It is also what makes the contradiction list correct. `no_agreement`
       * and `agreement_lapsed` are refused as a pair because they cannot both
       * hold, and under the live-statuses reading they could both hold of the
       * same person, so the refusal would have been wrong too.
       */
      return sql`not exists (
        select 1 from public.agreement a
        where a.customer_id = c.id and a.deleted_at is null
      )`;

    case "postal_code_in":
      /**
       * A linked property's postcode OR the billing postcode, and the
       * disjunction is on purpose. The service address is what a contractor
       * means by a postcode, and a customer with no linked property is not
       * therefore outside the area: plenty of records carry only the address
       * the invoice goes to, and excluding them would quietly shrink a
       * geographic campaign by however much of the list predates property
       * linking.
       */
      return sql`(
        exists (
          select 1 from public.customer_property cpr
          join public.property p on p.id = cpr.property_id
          where cpr.customer_id = c.id and p.deleted_at is null
            and p.postal_code = any(${sql.param(rule.codes.map((code) => code.trim()))}::text[])
        )
        or c.billing_postal_code = any(${sql.param(rule.codes.map((code) => code.trim()))}::text[])
      )`;

    case "tagged_any":
      /** `?|` is jsonb's "any of these appears", which is what the column is. */
      return sql`c.tags ?| ${sql.param(rule.tags.map((tag) => tag.trim()))}::text[]`;

    case "open_deficiency":
      /**
       * `open` and `quoted` both, because a quoted finding nobody approved is
       * the better half of this audience: the conversation has already
       * happened and the price is already known.
       */
      return sql`exists (
        select 1 from public.deficiency d
        where d.customer_id = c.id and d.deleted_at is null
          and d.status in ('open', 'quoted')
      )`;

    default: {
      /** A build error the day a rule is added to core and not to the query. */
      const unselectable: never = rule;
      throw new ConflictError(`No audience query for "${String(unselectable)}".`);
    }
  }
}

export interface Candidate {
  customerId: string;
  name: string;
  address: string;
}

/**
 * Who the rules select, on this channel, right now.
 *
 * THE CHANNEL IS PART OF THE SELECTION, not a filter applied afterwards. A
 * customer with no email address is not a recipient of an email campaign who
 * was skipped; they were never in it, and counting them as a skip makes a
 * reach rate that says the consent collection is failing when the truth is
 * that nobody ever asked for their address.
 *
 * `do_not_service` is excluded, and so is a merged record. The second one
 * matters more than it looks: a merge leaves the old row in place pointing at
 * the survivor, and selecting both sends the same person the same text twice
 * from two customer ids that the once-per-campaign index cannot see are one
 * person.
 */
async function select(
  tx: Database,
  channel: "sms" | "email",
  rules: readonly cp.AudienceRule[],
  limit: number,
): Promise<Candidate[]> {
  if (rules.length === 0) {
    /**
     * Unreachable through any public path, because `checkAudience` refuses an
     * empty rule list and every caller runs it first. Here anyway, because
     * what this function would otherwise do with no clauses is select the
     * entire customer list, and that is the one outcome this feature must not
     * have an accidental route to.
     */
    throw new ConflictError("An audience with no rules would be everybody. Refused.");
  }

  const addressColumn = channel === "email" ? sql`c.email` : sql`c.phone`;
  const clauses = rules.map(clauseFor);

  const rows = await tx.execute<{ customer_id: string; name: string; address: string }>(sql`
    select c.id as customer_id, c.name, ${addressColumn} as address
    from public.customer c
    where c.deleted_at is null
      and c.do_not_service = false
      and c.merged_into_id is null
      and ${addressColumn} is not null
      and btrim(${addressColumn}) <> ''
      and ${sql.join(clauses, sql` and `)}
    order by c.name asc, c.id asc
    limit ${limit}
  `);

  return rows.map((row) => ({
    customerId: row.customer_id,
    name: row.name,
    address: row.address,
  }));
}

/**
 * The most a single campaign will select.
 *
 * A ceiling rather than a page size: a send larger than this is a decision
 * somebody should make on purpose, in two campaigns, rather than discover
 * from a bill. Twenty five thousand is well past any one trades company's
 * list and well short of the number at which a mistake is unrecoverable.
 */
export const MAX_AUDIENCE = 25_000;

/* ----------------------------------------------------------------- parsing */

/**
 * Rules off the wire, into core's shape, or a refusal.
 *
 * The stored column is `jsonb`, so what comes back out of the database is
 * `Record<string, unknown>[]` and casting it to `AudienceRule[]` would be a
 * claim about a value this process did not produce. Re-checked on the way out
 * as well as in, because a rule that stopped being valid (core dropped a
 * kind) must refuse rather than reach `clauseFor` and hit the `never` branch
 * as a 500.
 */
export function parseRules(raw: unknown): cp.AudienceRule[] {
  const list = Array.isArray(raw) ? raw : [];
  const verdict = cp.checkAudience(list as cp.AudienceRule[]);
  if (!verdict.ok) {
    throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));
  }
  return verdict.rules;
}

/**
 * A utm value from a campaign name.
 *
 * Lowercased, spaces to hyphens, and nothing else kept. Derived rather than
 * typed twice because two fields that have to agree with nothing making them
 * agree is how an attribution report ends up with four spellings of one
 * campaign and a quarter of the credit under each.
 */
export function utmFor(name: string): string {
  const slug = name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug === "" ? "campaign" : slug;
}

/* ------------------------------------------------------------------ writes */

export interface CampaignInput {
  name: string;
  channel: "sms" | "email";
  audience: cp.AudienceRule[];
  /** The words. Optional only when `templateCode` names a message template to start from. */
  body?: string | undefined;
  subject?: string | null | undefined;
  /**
   * A message template (M18) to take the body and subject from. Copied in,
   * not linked: a campaign's words are fixed when it goes, and editing the
   * template next month must not change what this campaign says it sent.
   */
  templateCode?: string | undefined;
  utmCampaign?: string | undefined;
  messagingCampaignId?: string | null | undefined;
}

/**
 * A template's words, for a campaign on the same channel.
 *
 * Its placeholders are the templates' own syntax and are checked against the
 * campaign merge fields by `checkContent` like a body typed by hand, so a
 * template written for an arrival notice (`{{ visit.window }}`) is refused
 * here rather than sent with a hole in it.
 */
async function templateWords(
  tx: Database, organizationId: string, code: string, channel: "sms" | "email",
): Promise<{ body: string; subject: string | null }> {
  const [row] = await tx.select({
    body: schema.messageTemplate.body,
    subject: schema.messageTemplate.subject,
    channel: schema.messageTemplate.channel,
  }).from(schema.messageTemplate)
    .where(and(
      eq(schema.messageTemplate.organizationId, organizationId),
      eq(schema.messageTemplate.code, code),
      eq(schema.messageTemplate.active, true),
      isNull(schema.messageTemplate.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError(`Message template "${code}"`);
  if (row.channel !== channel) {
    throw new ConflictError(`"${code}" is a ${row.channel} template and this is a ${channel} campaign.`);
  }
  return { body: row.body, subject: row.subject };
}

/**
 * What the company is called and the number a customer would ring, for the
 * merge fields. The main number rather than the sending one, because "ring
 * us on" a number bought to absorb complaint rates is a number the customer
 * should not be given.
 */
async function companyScope(tx: Database, organizationId: string) {
  const [org] = await tx.select({ name: schema.organization.name })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const main = await senderFor(tx, organizationId, { smsRequired: false, purpose: "conversation" });
  return { companyName: org?.name ?? "", companyPhone: main?.e164 ?? null };
}

/** One recipient's words: the body and subject with the merge fields filled in. */
function personalise(
  words: { body: string; subject: string | null },
  scope: { companyName: string; companyPhone: string | null },
  customerName: string,
) {
  const values = cp.mergeScope({ customerName, ...scope });
  return {
    body: render(words.body, values),
    subject: words.subject ? render(words.subject, values) : null,
  };
}

function checkContent(input: {
  channel: "sms" | "email"; subject?: string | null | undefined; body: string;
}) {
  const verdict = cp.checkBody(input);
  if (!verdict.ok) {
    throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));
  }
}

export function create(ctx: ServiceContext, input: CampaignInput) {
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A campaign needs a name.");

    const verdict = cp.checkAudience(input.audience);
    if (!verdict.ok) {
      throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));
    }
    const fromTemplate = input.templateCode
      ? await templateWords(tx, ctx.actor.organizationId, input.templateCode, input.channel)
      : null;
    const words = {
      body: input.body?.trim() || fromTemplate?.body || "",
      subject: input.subject?.trim() || fromTemplate?.subject || null,
    };
    checkContent({ channel: input.channel, subject: words.subject, body: words.body });

    const utmCampaign = (input.utmCampaign?.trim() || utmFor(name));

    if (input.messagingCampaignId) {
      await assertCarrierCampaign(tx, ctx.actor.organizationId, input.messagingCampaignId);
    }

    /**
     * The UTM tag is unique among live campaigns, and it is derived from the name
     * unless somebody supplies one, so a second campaign named like the first
     * collides without anybody typing a tag at all. Attribution is the whole
     * point of the tag: two campaigns sharing one means the booked job six weeks
     * later names neither. `services/duplicates.ts`.
     */
    const [row] = await refusingDuplicate(
      "marketing_campaign_utm_idx",
      `"${utmCampaign}" is already the tag of a live campaign. Two campaigns on one tag means a `
      + `booked job can be attributed to neither, so give this one a different name or set its tag.`,
      () => tx.insert(schema.marketingCampaign).values({
        organizationId: ctx.actor.organizationId,
        name,
        channel: input.channel,
        audience: verdict.rules as unknown as Record<string, unknown>[],
        body: words.body,
        subject: input.channel === "email" ? words.subject : null,
        utmCampaign,
        messagingCampaignId: input.messagingCampaignId ?? null,
        createdByUserId: ctx.actor.userId === NIL ? null : ctx.actor.userId,
      }).returning(),
    );

    await audit(tx, ctx, "campaign.create", "marketing_campaign", row!.id, null, row);
    return viewWithin(tx, row!);
  });
}

const NIL = "00000000-0000-0000-0000-000000000000";

async function assertCarrierCampaign(tx: Database, organizationId: string, id: string) {
  /**
   * No `deleted_at` filter, and its absence is deliberate rather than an
   * omission. A carrier registration is not something this product soft
   * deletes: nothing in `messaging-registration.ts` writes that column and
   * nothing else reads it, so a filter here would be decorative, and a filter
   * that looks like a check is worse than none because the next reader stops
   * asking whether the check exists.
   */
  const [found] = await tx.select({ id: schema.messagingCampaign.id })
    .from(schema.messagingCampaign)
    .where(and(
      eq(schema.messagingCampaign.organizationId, organizationId),
      eq(schema.messagingCampaign.id, id),
    ))
    .limit(1);
  if (!found) throw new NotFoundError("Registered messaging campaign");
}

export interface CampaignPatch {
  id: string;
  name?: string | undefined;
  audience?: cp.AudienceRule[] | undefined;
  body?: string | undefined;
  subject?: string | null | undefined;
  scheduledFor?: string | null | undefined;
  messagingCampaignId?: string | null | undefined;
}

export function update(ctx: ServiceContext, input: CampaignPatch) {
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const current = await loadWithin(tx, ctx, input.id);

    /**
     * EDITABLE ONLY BEFORE IT GOES. Not a nicety: the body of a sent campaign
     * is what is in four thousand inboxes, and a record of it that somebody
     * can edit afterwards is not a record of anything. `canTransition` carries
     * the same rule for states.
     */
    if (current.state !== "draft" && current.state !== "scheduled") {
      throw new ConflictError(cp.transitionRefusal(current.state as cp.CampaignState, "draft"));
    }

    const channel = current.channel as "sms" | "email";
    const name = input.name?.trim() ?? current.name;
    if (name === "") throw new ConflictError("A campaign needs a name.");

    const audience = input.audience === undefined ? parseRules(current.audience) : (() => {
      const verdict = cp.checkAudience(input.audience!);
      if (!verdict.ok) throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));
      return verdict.rules;
    })();

    const body = input.body?.trim() ?? current.body;
    const subject = channel === "email"
      ? (input.subject === undefined ? current.subject : (input.subject?.trim() ?? null))
      : null;
    checkContent({ channel, subject, body });

    if (input.messagingCampaignId) {
      await assertCarrierCampaign(tx, ctx.actor.organizationId, input.messagingCampaignId);
    }

    const scheduledFor = input.scheduledFor === undefined
      ? current.scheduledFor
      : (input.scheduledFor === null ? null : new Date(input.scheduledFor));

    /**
     * Scheduling is what moves a draft to `scheduled`, and clearing the date
     * moves it back. One field rather than a state argument, because two ways
     * to say the same thing is two ways for them to disagree.
     */
    const state: cp.CampaignState = scheduledFor ? "scheduled" : "draft";

    const [updated] = await tx.update(schema.marketingCampaign).set({
      name,
      audience: audience as unknown as Record<string, unknown>[],
      body,
      subject,
      scheduledFor,
      state,
      ...(input.messagingCampaignId !== undefined
        ? { messagingCampaignId: input.messagingCampaignId }
        : {}),
      updatedAt: new Date(),
    }).where(eq(schema.marketingCampaign.id, input.id)).returning();

    await audit(tx, ctx, "campaign.update", "marketing_campaign", input.id, current, updated);
    return viewWithin(tx, updated!);
  });
}

export function cancel(ctx: ServiceContext, input: { id: string; reason?: string | undefined }) {
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const current = await loadWithin(tx, ctx, input.id);
    if (!cp.canTransition(current.state as cp.CampaignState, "cancelled")) {
      throw new ConflictError(cp.transitionRefusal(current.state as cp.CampaignState, "cancelled"));
    }

    const [updated] = await tx.update(schema.marketingCampaign).set({
      state: "cancelled",
      cancelledAt: new Date(),
      cancellationReason: input.reason?.trim() || null,
      updatedAt: new Date(),
    }).where(eq(schema.marketingCampaign.id, input.id)).returning();

    /**
     * The recipients already queued are NOT unqueued, and cannot be. A text
     * handed to a carrier is gone. Cancelling a part sent campaign stops the
     * rest, and the rows that went stay `queued` so the record says what
     * actually happened rather than what somebody wished had.
     */
    await audit(tx, ctx, "campaign.cancel", "marketing_campaign", input.id, current, updated);
    return viewWithin(tx, updated!);
  });
}

/**
 * Throw a draft away.
 *
 * DRAFTS ONLY, and it REFUSES when any recipient row exists. The state check
 * alone would be enough today, because recipients are written only by `send`
 * and `send` leaves the campaign `sending` or `sent`. The second check makes
 * that an invariant rather than a consequence of two functions agreeing: a
 * campaign with recipients is a record of what a company sent to real people,
 * and no path should be able to remove it because a state column said draft.
 *
 * Soft, so the partial unique index on the utm value lets the name be reused
 * while the audit trail keeps what was abandoned. That index is the reason
 * this operation has to exist at all: without a delete, one abandoned draft
 * would hold a campaign name forever.
 */
export function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const current = await loadWithin(tx, ctx, input.id);
    if (current.state !== "draft") {
      throw new ConflictError(
        `Only a draft can be deleted. This campaign is ${current.state}. Cancel it instead, so the `
        + "record of what went out survives.",
      );
    }

    const [{ n } = { n: "0" }] = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from public.campaign_recipient
      where campaign_id = ${input.id}
    `);
    if (Number(n) > 0) {
      throw new ConflictError(
        `This campaign has ${n} recipient rows, so something has already gone out under it. `
        + "Cancel it rather than deleting it.",
      );
    }

    await tx.update(schema.marketingCampaign)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.marketingCampaign.id, input.id));

    await audit(tx, ctx, "campaign.delete", "marketing_campaign", input.id, current, null);
    return { id: input.id, deleted: true as const };
  });
}

/* ------------------------------------------------------------------- reads */

async function loadWithin(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.marketingCampaign)
    .where(and(
      eq(schema.marketingCampaign.organizationId, ctx.actor.organizationId),
      eq(schema.marketingCampaign.id, id),
      isNull(schema.marketingCampaign.deletedAt),
    ))
    .limit(1);
  if (!row) throw new NotFoundError("Campaign");
  return row;
}

/**
 * The counts, from the recipient rows.
 *
 * Derived on every read rather than kept on the campaign, for the same reason
 * a stock level is derived: a stored total is a number somebody can edit into
 * agreement with what they hoped for, and this particular total is the one an
 * owner is judging a spend against.
 */
async function tallyWithin(tx: Database, campaignId: string): Promise<cp.CampaignResult> {
  const rows = await tx.execute<{ state: string; skip_reason: string | null; n: string }>(sql`
    select state, skip_reason, count(*)::text as n
    from public.campaign_recipient
    where campaign_id = ${campaignId}
    group by state, skip_reason
  `);

  const result: cp.CampaignResult = { selected: 0, queued: 0, skipped: 0, skippedBy: {} };
  for (const row of rows) {
    const n = Number(row.n);
    result.selected += n;
    if (row.state === "queued") result.queued += n;
    if (row.state === "skipped") {
      result.skipped += n;
      const reason = row.skip_reason ?? "unknown";
      result.skippedBy[reason] = (result.skippedBy[reason] ?? 0) + n;
    }
  }
  return result;
}

function viewOf(row: typeof schema.marketingCampaign.$inferSelect) {
  const rules = Array.isArray(row.audience) ? row.audience as unknown as cp.AudienceRule[] : [];
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    state: row.state,
    audience: rules as unknown as Record<string, unknown>[],
    audienceInWords: cp.describeAudience(rules),
    subject: row.subject,
    body: row.body,
    utmCampaign: row.utmCampaign,
    messagingCampaignId: row.messagingCampaignId,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The view, built inside the caller's transaction.
 *
 * A write path that returned `get(ctx, {id})` would open a second transaction
 * and read the state before its own uncommitted change, which is a mistake
 * this codebase has made and fixed twice.
 */
async function viewWithin(tx: Database, row: typeof schema.marketingCampaign.$inferSelect) {
  return { ...viewOf(row), result: await tallyWithin(tx, row.id) };
}

export function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    const row = await loadWithin(tx, ctx, input.id);
    return viewWithin(tx, row);
  });
}

export function list(ctx: ServiceContext, input: {
  state?: cp.CampaignState | undefined;
  limit: number;
}) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    const rows = await tx.select().from(schema.marketingCampaign)
      .where(and(
        eq(schema.marketingCampaign.organizationId, ctx.actor.organizationId),
        isNull(schema.marketingCampaign.deletedAt),
        ...(input.state ? [eq(schema.marketingCampaign.state, input.state)] : []),
      ))
      .orderBy(desc(schema.marketingCampaign.createdAt))
      .limit(input.limit);

    return {
      data: await Promise.all(rows.map(async (row) => ({
        ...viewOf(row),
        result: await tallyWithin(tx, row.id),
      }))),
    };
  });
}

/**
 * Who this would go to, and what it would cost, without sending anything.
 *
 * A SAMPLE OF NAMES COMES BACK, not only a count. A count is checkable only
 * against an expectation the owner already has; twenty names is checkable
 * against the list, and "why is my commercial account in a homeowner tune up
 * offer" is a question somebody can only ask if they can see the names.
 */
export function preview(ctx: ServiceContext, input: {
  id?: string | undefined;
  channel?: "sms" | "email" | undefined;
  audience?: cp.AudienceRule[] | undefined;
  sample?: number | undefined;
  /** Words to render against the first recipient, when previewing an unsaved campaign. */
  body?: string | undefined;
  subject?: string | null | undefined;
}) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    let channel: "sms" | "email";
    let rules: cp.AudienceRule[];
    let limits: { perSecond: number | null; dailyCap: number | null } = {
      perSecond: null, dailyCap: null,
    };

    if (input.id) {
      const row = await loadWithin(tx, ctx, input.id);
      channel = row.channel as "sms" | "email";
      rules = parseRules(row.audience);
      limits = await limitsWithin(tx, ctx.actor.organizationId, row);
    } else {
      if (!input.channel || !input.audience) {
        throw new ConflictError("Give a campaign id, or a channel and an audience to try.");
      }
      channel = input.channel;
      const verdict = cp.checkAudience(input.audience);
      if (!verdict.ok) throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));
      rules = verdict.rules;
    }

    const candidates = await select(tx, channel, rules, MAX_AUDIENCE + 1);
    const overflow = candidates.length > MAX_AUDIENCE;
    const count = overflow ? MAX_AUDIENCE : candidates.length;
    const sample = Math.min(input.sample ?? 20, 100);

    /**
     * THE MESSAGE AS THE FIRST PERSON ON THE LIST WILL READ IT, merge fields
     * filled in by the same renderer the send uses. "Hi {{ customer.firstName }}"
     * is a template; "Hi Maria" is what somebody checks before four thousand
     * of them go out, and it is the version that shows a field that came out
     * empty.
     */
    const words = input.id
      ? await loadWithin(tx, ctx, input.id).then((row) => ({ body: row.body, subject: row.subject }))
      : input.body ? { body: input.body, subject: input.subject ?? null } : null;
    const scope = await companyScope(tx, ctx.actor.organizationId);
    const first = candidates[0];
    const rendered = words
      ? {
        for: first?.name ?? null,
        ...personalise(words, scope, first?.name ?? cp.MERGE_FIELDS[1].example),
      }
      : null;

    return {
      count,
      /**
       * True when the rules matched more than a single campaign will take.
       * Reported rather than silently truncated: an owner who meant to reach
       * thirty thousand people needs to know this will reach the first
       * twenty five thousand by name order, which is not a random sample of
       * their list.
       */
      overflow,
      inWords: cp.describeAudience(rules),
      pace: cp.pace(count, limits),
      rendered,
      sample: candidates.slice(0, sample).map((c) => ({
        customerId: c.customerId, name: c.name, address: c.address,
      })),
    };
  });
}

/**
 * The carrier's throughput for this campaign, when it has one.
 *
 * Email has no equivalent and gets nulls, which `pace` reads as no declared
 * cap. That is honest rather than convenient: a provider's own rate limit is
 * enforced by the provider and this product does not know it.
 */
async function limitsWithin(
  tx: Database,
  organizationId: string,
  row: typeof schema.marketingCampaign.$inferSelect,
): Promise<{ perSecond: number | null; dailyCap: number | null }> {
  if (row.channel !== "sms" || !row.messagingCampaignId) {
    return { perSecond: null, dailyCap: null };
  }
  const [carrier] = await tx.select({
    perSecond: schema.messagingCampaign.messagesPerSecond,
    dailyCap: schema.messagingCampaign.dailyCap,
  })
    .from(schema.messagingCampaign)
    .where(and(
      eq(schema.messagingCampaign.organizationId, organizationId),
      eq(schema.messagingCampaign.id, row.messagingCampaignId),
    ))
    .limit(1);
  return { perSecond: carrier?.perSecond ?? null, dailyCap: carrier?.dailyCap ?? null };
}

/* ------------------------------------------------------------------- send */

export interface SendReport {
  campaignId: string;
  state: string;
  selected: number;
  queued: number;
  skipped: number;
  skippedBy: Record<string, number>;
  /** True when a daily cap left some of the audience for tomorrow. */
  remaining: number;
}

/**
 * Hand this campaign's batch to the outbox.
 *
 * ONE BATCH PER CALL, and the call is safe to repeat. A campaign under a
 * carrier's daily cap sends `cap` recipients and leaves the rest `pending`;
 * the next call takes the next batch. Calling it twice in one day sends
 * nothing extra, because the recipients already written are not re-selected
 * and the unique index on `(campaign_id, address)` is the backstop for the
 * case where they are.
 *
 * `at` comes from the caller rather than the clock for the same reason it
 * does on a visit outcome: a scheduled send that the worker picks up four
 * minutes late should be judged against the quiet hours of the moment it was
 * meant to go, and a test needs to be able to stand at eleven at night.
 */
export function send(ctx: ServiceContext, input: { id: string; at?: string | undefined }) {
  return guardedWrite(ctx, "campaign:write", async (tx): Promise<SendReport> => {
    /**
     * THE ROW IS LOCKED FOR THE BATCH. A person pressing send while the worker
     * fires the same campaign is two senders selecting the same recipients,
     * and the unique index only catches that after the email half has queued
     * its messages in their own transactions. The second sender waits here,
     * then finds the recipients already written and selects nobody.
     */
    await tx.execute(sql`select id from public.marketing_campaign where id = ${input.id} for update`);
    const row = await loadWithin(tx, ctx, input.id);
    const at = input.at ? new Date(input.at) : new Date();

    const state = row.state as cp.CampaignState;
    if (!cp.canTransition(state, "sending")) {
      throw new ConflictError(cp.transitionRefusal(state, "sending"));
    }

    const channel = row.channel as "sms" | "email";
    const rules = parseRules(row.audience);
    checkContent({ channel, subject: row.subject, body: row.body });

    const limits = await limitsWithin(tx, ctx.actor.organizationId, row);

    /**
     * NO PRE-FLIGHT CHECK FOR THE UNSUBSCRIBE HOST, AND THERE WAS ONE HERE.
     *
     * It read `if (channel === "email") assertCanLink()`, and the comment said
     * it was there so a missing `PUBLIC_BASE_URL` was not discovered one
     * recipient at a time. The breakage sweep removed it and every test stayed
     * green, which was correct: `mintUnsubscribe` checks the host BEFORE it
     * inserts anything, and the throw aborts the surrounding transaction, so
     * with or without the line the outcome is one refusal naming the variable
     * and nothing written. The line was two reads earlier in the function and
     * nothing else.
     *
     * Deleted rather than given a test, because there was no behaviour to
     * test. A guard whose removal changes nothing is not a guard, and leaving
     * it would mean the next reader believes the ordering matters.
     *
     * What must not change is the order inside `mintUnsubscribe`: host first,
     * row second. Minting a token, writing the row and then refusing would
     * leave a live unsubscribe link for a mail that was never sent.
     */
    /**
     * Already written, so a repeat call does not re-send. Read before
     * selecting rather than relied on through the unique index, because a
     * conflict would abort the whole batch's transaction and the index is
     * there for the race rather than for the ordinary case.
     */
    const already = new Set((await tx.select({ address: schema.campaignRecipient.address })
      .from(schema.campaignRecipient)
      .where(eq(schema.campaignRecipient.campaignId, row.id)))
      .map((r) => r.address));

    const normalize = (address: string) => channel === "email"
      ? email.normalizeAddress(address)
      : comms.phoneAddress(address);

    const candidates = (await select(tx, channel, rules, MAX_AUDIENCE))
      .map((candidate) => ({ ...candidate, address: normalize(candidate.address) }))
      .filter((candidate) => !already.has(candidate.address));

    /**
     * DEDUPED BY ADDRESS INSIDE THE BATCH TOO. Two customer records sharing a
     * phone number is ordinary (a husband and a wife, a landlord and their
     * company) and the unique index would refuse the second insert mid batch.
     * Keeping the first and dropping the rest is also the right answer for the
     * person holding the phone, who does not want it twice.
     */
    const seen = new Set<string>();
    const fresh = candidates.filter((candidate) => {
      if (seen.has(candidate.address)) return false;
      seen.add(candidate.address);
      return true;
    });

    /**
     * THE DAILY CAP IS A DAY, NOT A CALL. `pace` answers how many one batch
     * may take; what has already gone in the last twenty four hours comes
     * off it, so a second press the same afternoon, or the worker coming
     * round again five seconds later, does not send a second day's worth into
     * a carrier that will reject it.
     */
    const [sentToday] = await tx.select({ n: sql<number>`count(*)::int` })
      .from(schema.campaignRecipient)
      .where(and(
        eq(schema.campaignRecipient.campaignId, row.id),
        eq(schema.campaignRecipient.state, "queued"),
        sql`${schema.campaignRecipient.queuedAt} > ${new Date(at.getTime() - 86_400_000).toISOString()}::timestamptz`,
      ));
    const capLeft = limits.dailyCap === null
      ? null
      : Math.max(0, limits.dailyCap - (sentToday?.n ?? 0));
    const plan = cp.pace(fresh.length, { perSecond: limits.perSecond, dailyCap: capLeft });
    const batch = fresh.slice(0, plan.firstBatch);
    const remaining = fresh.length - batch.length;
    const scope = await companyScope(tx, ctx.actor.organizationId);

    for (const candidate of batch) {
      /** Their own words: "Hi Maria" rather than "Hi {{ customer.firstName }}". */
      const words = personalise({ body: row.body, subject: row.subject }, scope, candidate.name);
      const outcome = channel === "sms"
        ? await commsSend.sendMarketing(tx, {
          organizationId: ctx.actor.organizationId,
          address: candidate.address,
          body: words.body,
          customerId: candidate.customerId,
          at,
        })
        : await sendCampaignEmail(tx, ctx, {
          campaignId: row.id,
          address: candidate.address,
          customerId: candidate.customerId,
          subject: words.subject ?? "",
          body: words.body,
          at,
        });

      await tx.insert(schema.campaignRecipient).values({
        organizationId: ctx.actor.organizationId,
        campaignId: row.id,
        customerId: candidate.customerId,
        address: candidate.address,
        state: outcome.sent ? "queued" : "skipped",
        skipReason: outcome.sent ? null : outcome.reason,
        messageId: outcome.sent ? outcome.messageId : null,
        queuedAt: outcome.sent ? at : null,
      });
    }

    /**
     * `sent` only when nothing is left. A staged campaign stays `sending`
     * between days, which is what the `sending -> sending` transition is for:
     * marking it sent while a third of the list has not been written would
     * make the campaign's own state say the send finished.
     */
    const finished = remaining === 0;
    const [updated] = await tx.update(schema.marketingCampaign).set({
      state: finished ? "sent" : "sending",
      startedAt: row.startedAt ?? at,
      finishedAt: finished ? at : null,
      updatedAt: new Date(),
    }).where(eq(schema.marketingCampaign.id, row.id)).returning();

    const tally = await tallyWithin(tx, row.id);
    await audit(tx, ctx, "campaign.send", "marketing_campaign", row.id, row, {
      ...updated, batch: batch.length, remaining,
    });

    return {
      campaignId: row.id,
      state: updated!.state,
      selected: tally.selected,
      queued: tally.queued,
      skipped: tally.skipped,
      skippedBy: tally.skippedBy,
      remaining,
    };
  });
}

/**
 * One campaign email, with the unsubscribe link that makes it legal.
 *
 * The token is minted per recipient rather than per address, because the
 * complaint rate that matters is the one for THIS send: a link that resolves
 * only to an address cannot tell an owner which campaign lost them two
 * hundred subscribers.
 */
async function sendCampaignEmail(tx: Database, ctx: ServiceContext, input: {
  campaignId: string;
  address: string;
  customerId: string;
  subject: string;
  body: string;
  at: Date;
}): Promise<{ sent: true; messageId: string } | { sent: false; reason: string }> {
  /**
   * QUIET HOURS APPLY TO EMAIL TOO, and the reason is not the law. Email is
   * outside the TCPA, and a marketing email arriving at two in the morning
   * still lands at the top of an inbox read at seven with eleven hours of
   * other mail on top of it, or wakes a phone. The window is the company's
   * own, so a company that wants to send overnight turns it off once.
   */
  const quiet = await commsSend.quietHoursFor(tx, ctx.actor.organizationId, input.at);
  if (quiet.window && comms.inQuietHours(quiet.localHour, quiet.window)) {
    return { sent: false, reason: "quiet_hours" };
  }

  const { url } = await mintUnsubscribe(tx, ctx.actor.organizationId, {
    address: input.address,
    campaignId: input.campaignId,
  });

  const outcome = await email.queue(ctx, {
    to: input.address,
    subject: input.subject,
    text: input.body,
    purpose: "marketing",
    customerId: input.customerId,
    unsubscribeUrl: url,
  });

  return outcome.queued
    ? { sent: true, messageId: outcome.messageId }
    : { sent: false, reason: outcome.reason };
}

/* ------------------------------------------------------- the unsubscribe */

/**
 * Where an unsubscribe link points.
 *
 * `PUBLIC_BASE_URL` is the deployment's own address, and when it is not set
 * the link is a path. A relative List-Unsubscribe header is not useful to a
 * mailbox provider, so a deployment that has not told this product its own
 * hostname gets a refusal from `email.queue` rather than a header that
 * silently does not work.
 */
function baseUrl(): string {
  return (process.env["PUBLIC_BASE_URL"] ?? "").replace(/\/+$/, "");
}

/**
 * The refusal when this deployment has not been told its own address.
 *
 * Raised before anything is written, and before the first recipient rather
 * than at it. The other order mints a token, inserts a row, then throws, so
 * one missing environment variable aborts a two thousand person send on its
 * first recipient and leaves nothing explaining why.
 */
function assertCanLink(): string {
  const base = baseUrl();
  if (base === "") {
    throw new ConflictError(
      "PUBLIC_BASE_URL is not set, so this deployment cannot build an unsubscribe link, and an "
      + "email campaign without a working one is refused. A relative URL in a List-Unsubscribe "
      + "header is not a working one: the mailbox provider fetching it has no host to resolve.",
    );
  }
  return base;
}

export async function mintUnsubscribe(tx: Database, organizationId: string, input: {
  address: string;
  campaignId?: string | null | undefined;
}): Promise<{ token: string; url: string }> {
  const base = assertCanLink();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");

  await tx.insert(schema.unsubscribeLink).values({
    organizationId,
    tokenHash,
    address: email.normalizeAddress(input.address),
    campaignId: input.campaignId ?? null,
  });

  return { token, url: `${base}/api/v1/public/unsubscribe/${token}` };
}

/* ------------------------------------------------------------ the clock */

export interface DueResult {
  campaignId: string;
  organizationId: string;
  action: "sent" | "waiting" | "skipped";
  reason?: string;
  queued?: number;
  remaining?: number;
}

/**
 * The person a scheduled send acts as: whoever wrote the campaign, with what
 * they hold NOW.
 *
 * Not a system actor granted `campaign:write`. Building an actor and handing
 * it the permission its own guard checks is the moment that guard stops
 * meaning anything, and the next caller in a hurry does the same. A scheduled
 * send is the author's own action, deferred, so it is checked against the
 * author's membership at the moment it fires: somebody whose access was taken
 * away on Tuesday does not send a campaign on Wednesday.
 */
async function authorOf(tx: Database, row: typeof schema.marketingCampaign.$inferSelect): Promise<Actor | null> {
  if (!row.createdByUserId) return null;
  const [member] = await tx.select({
    role: schema.membership.role,
    grants: schema.membership.grants,
    revocations: schema.membership.revocations,
    active: schema.membership.active,
    customPermissions: schema.role.permissions,
  }).from(schema.membership)
    .leftJoin(schema.role, eq(schema.role.id, schema.membership.roleId))
    .where(and(
      eq(schema.membership.organizationId, row.organizationId),
      eq(schema.membership.userId, row.createdByUserId),
    )).limit(1);
  if (!member || !member.active) return null;
  const resolved = resolveMembership({
    role: member.role as RoleId,
    ...(member.customPermissions
      ? { customRole: { permissions: member.customPermissions as Permission[], scopes: {} } }
      : {}),
    grants: member.grants as Permission[],
    revocations: member.revocations as Permission[],
  });
  return {
    userId: row.createdByUserId,
    organizationId: row.organizationId,
    roles: [],
    grants: resolved.permissions,
  };
}

/**
 * FIRE WHAT IS DUE. `scheduled_for` was stored for a long time and fired by
 * nothing, so a staged send was one press per batch for as many days as the
 * carrier's cap made it. The worker calls this every pass.
 *
 * Three things keep it from doing harm, and each is a reason it waits rather
 * than refusing:
 *
 *   QUIET HOURS. Inside the company's window it does nothing and comes back.
 *   Sending would write every recipient as skipped for `quiet_hours`, which
 *   is permanent: a scheduled campaign that fired at 9.05pm would reach
 *   nobody, ever.
 *
 *   THE DAILY CAP. `send` takes what is left of the last twenty four hours'
 *   cap and no more, so coming round every few seconds is harmless.
 *
 *   IDEMPOTENCE. `send` locks the campaign and never re-selects a recipient
 *   already written, so two workers, or a worker and a person pressing the
 *   button, send each person one message.
 */
export async function sendDue(
  db: Database,
  options: { now?: Date; limit?: number; shouldStop?: () => boolean } = {},
): Promise<DueResult[]> {
  const now = options.now ?? new Date();
  const rows = await db.execute<{ organization_id: string; campaign_id: string }>(
    sql`select organization_id, campaign_id from app.due_campaigns(${options.limit ?? 50})`,
  );
  const results: DueResult[] = [];
  for (const due of rows) {
    if (options.shouldStop?.()) break;
    const base = { campaignId: due.campaign_id, organizationId: due.organization_id };
    try {
      const system: ServiceContext = {
        actor: { userId: SYSTEM_USER_ID, organizationId: due.organization_id, roles: [], agentId: "campaigns" },
        db,
      };
      const ready = await inTenant(system, async (tx) => {
        const [row] = await tx.select().from(schema.marketingCampaign)
          .where(eq(schema.marketingCampaign.id, due.campaign_id)).limit(1);
        if (!row) return { wait: "gone" } as const;
        const quiet = await commsSend.quietHoursFor(tx, due.organization_id, now);
        if (quiet.window && comms.inQuietHours(quiet.localHour, quiet.window)) {
          return { wait: "quiet_hours" } as const;
        }
        const limits = await limitsWithin(tx, due.organization_id, row);
        if (limits.dailyCap !== null) {
          const [today] = await tx.select({ n: sql<number>`count(*)::int` })
            .from(schema.campaignRecipient)
            .where(and(
              eq(schema.campaignRecipient.campaignId, row.id),
              eq(schema.campaignRecipient.state, "queued"),
              sql`${schema.campaignRecipient.queuedAt} > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
            ));
          if ((today?.n ?? 0) >= limits.dailyCap) return { wait: "daily_cap" } as const;
        }
        const author = await authorOf(tx, row);
        return author ? { author } as const : { wait: "no_author" } as const;
      });
      if ("wait" in ready) {
        results.push({ ...base, action: "waiting", reason: ready.wait });
        continue;
      }
      const report = await send({ actor: ready.author, db }, { id: due.campaign_id, at: now.toISOString() });
      results.push({ ...base, action: "sent", queued: report.queued, remaining: report.remaining });
    } catch (error) {
      /**
       * One campaign's refusal (its author lost the permission, its carrier
       * registration was withdrawn) must not stop the clock for every other
       * company. The campaign stays due and the reason is in the log.
       */
      results.push({ ...base, action: "skipped", reason: (error as Error).message });
    }
  }
  return results;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  createCampaign: (ctx: ServiceContext, input: CampaignInput) => create(ctx, input),
  updateCampaign: (ctx: ServiceContext, input: CampaignPatch) => update(ctx, input),
  cancelCampaign: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    cancel(ctx, input),
  deleteCampaign: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
  getCampaign: get,
  listCampaigns: list,
  previewCampaign: preview,
  sendCampaign: send,
  campaignRecipients: (ctx: ServiceContext, input: {
    id: string; state?: cp.RecipientState | undefined; limit: number;
  }) => recipients(ctx, input),
  campaignResults: (ctx: ServiceContext, input: { id: string }) => results(ctx, input),
} as const;

/**
 * Who it went to, and who it did not, with the reason.
 *
 * The skipped list is the useful half. Every row on it with `no_consent` is a
 * customer whose number this company has and may not text, which is a
 * worklist for the office rather than a statistic: ask at the next visit and
 * the next campaign is that much bigger.
 */
export function recipients(ctx: ServiceContext, input: {
  id: string; state?: cp.RecipientState | undefined; limit: number;
}) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    await loadWithin(tx, ctx, input.id);
    const rows = await tx.select({
      id: schema.campaignRecipient.id,
      customerId: schema.campaignRecipient.customerId,
      customerName: schema.customer.name,
      address: schema.campaignRecipient.address,
      state: schema.campaignRecipient.state,
      skipReason: schema.campaignRecipient.skipReason,
      messageId: schema.campaignRecipient.messageId,
      queuedAt: schema.campaignRecipient.queuedAt,
    })
      .from(schema.campaignRecipient)
      .leftJoin(schema.customer, eq(schema.customer.id, schema.campaignRecipient.customerId))
      /**
       * NO `deleted_at` FILTER, HERE OR IN THE TALLY ABOVE. A recipient row is
       * the record that this company sent this address this message on this
       * day, and there is no operation anywhere that removes one: the only
       * writer is the sender. Filtering on a column nothing sets would be a
       * check that cannot fail, and the useful half of this list is the
       * skipped rows, which is exactly the half somebody would be tempted to
       * tidy away.
       */
      .where(and(
        eq(schema.campaignRecipient.campaignId, input.id),
        ...(input.state ? [eq(schema.campaignRecipient.state, input.state)] : []),
      ))
      .orderBy(asc(schema.campaignRecipient.state), asc(schema.campaignRecipient.address))
      .limit(input.limit);

    return {
      data: rows.map((row) => ({
        id: row.id,
        customerId: row.customerId,
        customerName: row.customerName,
        address: row.address,
        state: row.state,
        skipReason: row.skipReason,
        /** The sentence, not the identifier. An operator reads this. */
        skipExplanation: row.skipReason
          ? commsSend.refusal(row.skipReason as comms.SendRefusal)
          : null,
        messageId: row.messageId,
        queuedAt: row.queuedAt?.toISOString() ?? null,
      })),
    };
  });
}

/**
 * What the campaign brought back.
 *
 * THE JOINS GO THROUGH `job.campaign_id`, which this is the first writer and
 * the first reader of. A job gets that id when it is created from a touch
 * carrying this campaign's utm value, which is how a booking six weeks after
 * a text is credited to the text.
 *
 * NO CONVERSION RATE IS RETURNED, deliberately, and this is the one number
 * every tool in this category prints. Jobs divided by recipients is a figure
 * whose numerator is attributed under whichever model the reader has not
 * chosen, and quoting one here would make this product's answer differ from
 * the attribution report's answer for the same campaign. The counts and the
 * revenue are facts; what share of them the campaign caused is a question
 * `marketing.compareModels` exists to answer, with the model named.
 */
export function results(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    const row = await loadWithin(tx, ctx, input.id);
    const tally = await tallyWithin(tx, row.id);

    /**
     * Revenue is `marketing.REVENUE_SQL`, the one definition every marketing
     * figure shares: what the ledger recognised on the job, without the tax
     * and with voids and credits taken off. This used to sum `job.total`, a
     * figure on the job, so the campaign and the attribution report disagreed
     * about the same work by the sales tax.
     */
    const [work] = await tx.execute<{ jobs: string; revenue: string | null }>(sql`
      select count(*)::text as jobs, coalesce(sum(${sql.raw(REVENUE_SQL)}), 0)::text as revenue
      from public.job job
      where job.campaign_id = ${row.id} and job.deleted_at is null
    `);

    const [replies] = await tx.execute<{ n: string }>(sql`
      select count(distinct m.conversation_id)::text as n
      from public.message m
      join public.campaign_recipient r
        on r.campaign_id = ${row.id} and r.message_id is not null
      join public.message sent on sent.id = r.message_id
      where m.conversation_id = sent.conversation_id
        and m.direction = 'inbound'
        and m.created_at >= sent.created_at
    `);

    const [optOuts] = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n
      from public.unsubscribe_link
      where campaign_id = ${row.id} and used_at is not null
    `);

    return {
      campaign: viewOf(row),
      result: tally,
      /** The share of the audience that could be contacted at all, as a string. */
      reachRate: cp.reachRate(tally),
      replies: Number(replies?.n ?? "0"),
      optOuts: Number(optOuts?.n ?? "0"),
      jobs: Number(work?.jobs ?? "0"),
      revenue: work?.revenue ?? "0",
    };
  });
}
