import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { membership, money as m } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, ConflictError, type ServiceContext } from "./context";
import * as templates from "./message-templates";
import type { TemplateInput } from "./message-templates";
import { render } from "../lib/render";

/**
 * THE RENEWAL NOTICE: ITS WORDS AND HOW IT GOES
 *
 * The notice a plan owes before a term ends was a sentence written in the
 * agreements service and sent by text when the customer could be texted and
 * by email when they could not. Both are the company's choice, not ours: the
 * words are its voice to a member, and in some states the notice for an
 * automatically renewing contract has to say particular things, which a
 * company's lawyer may want worded their way. So the words are message
 * templates the company edits, seeded with the wording the product always
 * sent, and how it goes is a company setting: text first, email first, or
 * both.
 *
 * Two situations, because they say different things: a term that renews on
 * its own (the date, the price, and how to stop it) and one that does not
 * (the last day of cover, and how to renew). Each has a text and an email.
 */

export type NoticeChannel = "text_first" | "email_first" | "both";
export type NoticeSituation = "renews" | "ends";

export const NOTICE_CODES = {
  renews: { sms: "agreement_renewal.renews.sms", email: "agreement_renewal.renews.email" },
  ends: { sms: "agreement_renewal.ends.sms", email: "agreement_renewal.ends.email" },
} as const;

export type NoticeCode =
  | typeof NOTICE_CODES.renews.sms | typeof NOTICE_CODES.renews.email
  | typeof NOTICE_CODES.ends.sms | typeof NOTICE_CODES.ends.email;

/** What a renewal notice's words may use. Said on the editing screen. */
export const NOTICE_VARIABLES = [
  "customer.firstName", "company.name", "plan.name", "plan.termMonths",
  "agreement.renewsOn", "agreement.lastCoveredDay", "agreement.price",
] as const;

const RENEWS_BODY = "Hi {{ customer.firstName }}, your {{ plan.name }} with {{ company.name }} renews on "
  + "{{ agreement.renewsOn }} for another {{ plan.termMonths }} months at {{ agreement.price }}. "
  + "Reply to this message if you would like to change or cancel it.";
const ENDS_BODY = "Hi {{ customer.firstName }}, your {{ plan.name }} with {{ company.name }} covers you until "
  + "{{ agreement.lastCoveredDay }}. Reply to this message if you would like to renew it.";

/**
 * The wording the product sent before it was a template, word for word, so a
 * company that never opens the screen sends exactly what it always did.
 */
export const DEFAULT_NOTICES: readonly (TemplateInput & { code: NoticeCode; situation: NoticeSituation })[] = [
  {
    code: NOTICE_CODES.renews.sms, situation: "renews", name: "Renewal notice: renews on its own (text)",
    channel: "sms", body: RENEWS_BODY, variables: [...NOTICE_VARIABLES],
  },
  {
    code: NOTICE_CODES.renews.email, situation: "renews", name: "Renewal notice: renews on its own (email)",
    channel: "email", subject: "Your {{ plan.name }} renews on {{ agreement.renewsOn }}", body: RENEWS_BODY,
    variables: [...NOTICE_VARIABLES],
  },
  {
    code: NOTICE_CODES.ends.sms, situation: "ends", name: "Renewal notice: does not renew on its own (text)",
    channel: "sms", body: ENDS_BODY, variables: [...NOTICE_VARIABLES],
  },
  {
    code: NOTICE_CODES.ends.email, situation: "ends", name: "Renewal notice: does not renew on its own (email)",
    channel: "email", subject: "Your {{ plan.name }} is coming to an end", body: ENDS_BODY,
    variables: [...NOTICE_VARIABLES],
  },
];

/** Put the four templates in place for a company, with the product's own wording. A new company gets them at once. */
export async function seedNoticeTemplates(tx: Database, organizationId: string): Promise<void> {
  await templates.seedWithin(tx, organizationId, DEFAULT_NOTICES.map(({ situation: _, ...t }) => t));
}

const longDay = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

/** What the placeholders read, for one agreement's notice. */
export function noticeScope(input: {
  customerName: string; organizationName: string; planName: string;
  endsOn: string; price: string; termMonths: number;
}): Record<string, unknown> {
  return {
    customer: { firstName: input.customerName.split(" ")[0] || input.customerName, name: input.customerName },
    company: { name: input.organizationName },
    plan: { name: input.planName, termMonths: input.termMonths },
    agreement: {
      renewsOn: longDay(input.endsOn),
      /** The end date is the first day without cover; a customer reads the last day with it. */
      lastCoveredDay: longDay(membership.lastCoveredDay(input.endsOn)),
      price: m.format(m.money(input.price, "USD")),
    },
  };
}

export interface RenderedNotice { text: string; email: { subject: string; body: string } }

/**
 * The notice in the company's words, or the product's own when a template is
 * missing or switched off: a notice owed is sent whatever happened to the
 * template, because the alternative is a member renewed without being told.
 */
export async function renderNotice(
  tx: Database, organizationId: string, situation: NoticeSituation, scope: Record<string, unknown>,
): Promise<RenderedNotice> {
  const codes = NOTICE_CODES[situation];
  const fallback = (code: NoticeCode) => DEFAULT_NOTICES.find((d) => d.code === code)!;
  const [text, mail] = await Promise.all([
    templates.renderWithin(tx, organizationId, codes.sms, scope),
    templates.renderWithin(tx, organizationId, codes.email, scope),
  ]);
  const defaultMail = fallback(codes.email);
  return {
    text: text?.body ?? render(fallback(codes.sms).body, scope),
    email: {
      subject: mail?.subject ?? render(defaultMail.subject ?? "", scope),
      body: mail?.body ?? render(defaultMail.body, scope),
    },
  };
}

/* ---------------------------------------------------------------- the setting */

const CHANNELS: readonly NoticeChannel[] = ["text_first", "email_first", "both"];

/** How the company sends the notice. Text first, falling back to email, is what it always did. */
export async function channelWithin(tx: Database, organizationId: string): Promise<NoticeChannel> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const saved = ((row?.settings ?? {}) as Record<string, unknown>)["renewalNotices"] as { channel?: unknown } | undefined;
  return CHANNELS.includes(saved?.channel as NoticeChannel) ? saved!.channel as NoticeChannel : "text_first";
}

export interface NoticeSettings {
  channel: NoticeChannel;
  templates: {
    code: NoticeCode;
    situation: NoticeSituation;
    channel: "sms" | "email";
    name: string;
    subject: string | null;
    body: string;
    /** No template is saved for this one, so the product's own wording is sent. */
    isDefault: boolean;
  }[];
  variables: string[];
}

async function settingsWithin(tx: Database, organizationId: string): Promise<NoticeSettings> {
  const saved = await templates.byCodesWithin(tx, DEFAULT_NOTICES.map((d) => d.code));
  return {
    channel: await channelWithin(tx, organizationId),
    templates: DEFAULT_NOTICES.map((d) => {
      const row = saved.find((t) => t.code === d.code && t.active);
      return {
        code: d.code,
        situation: d.situation,
        channel: d.channel as "sms" | "email",
        name: d.name,
        subject: row ? row.subject : d.subject ?? null,
        body: row ? row.body : d.body,
        isDefault: !row,
      };
    }),
    variables: [...NOTICE_VARIABLES],
  };
}

/**
 * The renewal notice's words and how it goes, for the screen that edits
 * them. `settings:read`, the permission every message template is read under.
 */
export async function settings(ctx: ServiceContext): Promise<NoticeSettings> {
  return guardedRead(ctx, "settings:read", (tx) => settingsWithin(tx, ctx.actor.organizationId));
}

/**
 * Change how the notice goes, its words, or both, in one transaction.
 *
 * `settings:write`, because both are the company's: the same permission that
 * edits any message template. The words are checked the way every template
 * is (`message-templates.normalise`): a placeholder that is not one of the
 * notice's own is refused, because it would send a sentence with a hole in it
 * to every member at renewal time.
 */
export async function update(ctx: ServiceContext, input: {
  channel?: NoticeChannel | undefined;
  templates?: { code: NoticeCode; subject?: string | null | undefined; body: string }[] | undefined;
}): Promise<NoticeSettings> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    if (input.channel !== undefined) {
      if (!CHANNELS.includes(input.channel)) throw new ConflictError("Send the notice by text first, email first, or both.");
      const before = await channelWithin(tx, ctx.actor.organizationId);
      await tx.update(schema.organization).set({
        settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ renewalNotices: { channel: input.channel } })}::jsonb`,
        updatedAt: new Date(),
      }).where(eq(schema.organization.id, ctx.actor.organizationId));
      await audit(tx, ctx, "agreement.renewal_notice_channel_set", "organization", ctx.actor.organizationId,
        { channel: before }, { channel: input.channel });
    }
    for (const edit of input.templates ?? []) {
      const base = DEFAULT_NOTICES.find((d) => d.code === edit.code);
      if (!base) throw new ConflictError(`"${edit.code}" is not one of the renewal notice's templates.`);
      const { situation: _, ...rest } = base;
      await templates.saveWithin(tx, ctx, {
        ...rest,
        subject: base.channel === "email" ? (edit.subject ?? base.subject ?? null) : null,
        body: edit.body,
        variables: [...NOTICE_VARIABLES],
      });
    }
    return settingsWithin(tx, ctx.actor.organizationId);
  });
}

export const handlers = {
  getAgreementRenewalNotices: (ctx: ServiceContext) => settings(ctx),
  updateAgreementRenewalNotices: (ctx: ServiceContext, input: Parameters<typeof update>[1]) => update(ctx, input),
} as const;
