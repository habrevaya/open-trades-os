import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, branding, can, setup as rules, isSystem } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { inForceAt, reviseWithin } from "./pricebook";
import { replayed, remember } from "./once";

/**
 * THE SETUP WIZARD'S MEMORY
 *
 * Which steps somebody has said are done, and, beside each, what is already in
 * place, so the person deciding whether a step is finished can see the facts
 * rather than remember them.
 *
 * DONE IS SAID, NOT INFERRED. `schema/setup.ts` explains why: most of these
 * steps have no answer in the data. A price book at national averages looks
 * exactly like one somebody checked line by line. What the data CAN say is
 * stated beside the step ("Stripe is connected", "43 items, 12 taxable"), and
 * the wizard puts the two next to each other. A step marked done with nothing
 * behind it, or a connected Stripe on a step nobody has ticked, are both
 * visible rather than one of them hidden behind the other.
 */

export interface StepState {
  key: rules.SetupStepKey;
  title: string;
  summary: string;
  essential: boolean;
  hasLeadTime: boolean;
  permission: string;
  done: boolean;
  doneAt: string | null;
  /** Whether the person asking may do this step, and so mark it. */
  allowed: boolean;
  /** What is already in place, in words. Empty when there is nothing to say. */
  facts: string[];
}

export interface SetupView {
  companyName: string;
  setupCompletedAt: string | null;
  progress: rules.SetupProgress;
  steps: StepState[];
}

export async function view(ctx: ServiceContext): Promise<SetupView> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const [org] = await tx.select().from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    if (!org) throw new NotFoundError("Company");

    const rows = await tx.select().from(schema.setupStep)
      .where(eq(schema.setupStep.organizationId, ctx.actor.organizationId));
    const completed = new Map(rows.filter((r) => r.completedAt).map((r) => [r.stepKey, r.completedAt!]));
    const facts = await factsFor(tx, ctx.actor.organizationId, org);

    return {
      companyName: org.name,
      setupCompletedAt: org.setupCompletedAt?.toISOString() ?? null,
      progress: rules.progress(new Set(completed.keys()), (p) => can(ctx.actor, p)),
      steps: rules.SETUP_STEPS.map((step) => ({
        key: step.key,
        title: step.title,
        summary: step.summary,
        essential: step.essential,
        hasLeadTime: step.hasLeadTime,
        permission: step.permission,
        done: completed.has(step.key),
        doneAt: completed.get(step.key)?.toISOString() ?? null,
        allowed: can(ctx.actor, step.permission),
        facts: facts[step.key] ?? [],
      })),
    };
  });
}

/**
 * Mark a step done, or not done again.
 *
 * Needs the step's own permission as well as `settings:read`, because saying
 * "payments is done" is a statement about payments, and the office manager
 * who cannot connect Stripe should not be the one to close it.
 */
export async function mark(
  ctx: ServiceContext, input: { key: string; done: boolean },
): Promise<{ key: rules.SetupStepKey; done: boolean; progress: rules.SetupProgress }> {
  assertCan(ctx.actor, "settings:read");
  const step = rules.stepByKey(input.key);
  if (!step) throw new NotFoundError(`Setup step "${input.key}"`);
  return guardedWrite(ctx, step.permission, async (tx) => {
    const now = new Date();
    const by = isSystem(ctx.actor) ? null : ctx.actor.userId;
    const [before] = await tx.select().from(schema.setupStep)
      .where(and(
        eq(schema.setupStep.organizationId, ctx.actor.organizationId),
        eq(schema.setupStep.stepKey, step.key),
      )).limit(1);

    /**
     * Upserted on the step's key, which the unique index makes one row.
     * Marking done what is already done keeps the first time it was done,
     * because "when did we finish payments" is the question this answers.
     */
    const completedAt = input.done ? (before?.completedAt ?? now) : null;
    await tx.insert(schema.setupStep).values({
      organizationId: ctx.actor.organizationId,
      stepKey: step.key,
      completedAt,
      changedByUserId: by,
    }).onConflictDoUpdate({
      target: [schema.setupStep.organizationId, schema.setupStep.stepKey],
      set: { completedAt, changedByUserId: by, updatedAt: now },
    });

    if ((before?.completedAt !== null && before?.completedAt !== undefined) !== input.done) {
      await audit(tx, ctx, input.done ? "setup.step_done" : "setup.step_reopened", "organization",
        ctx.actor.organizationId, { step: step.key, done: !input.done }, { step: step.key, done: input.done });
    }

    const rows = await tx.select({ key: schema.setupStep.stepKey, at: schema.setupStep.completedAt })
      .from(schema.setupStep)
      .where(eq(schema.setupStep.organizationId, ctx.actor.organizationId));
    const done = new Set(rows.filter((r) => r.at !== null).map((r) => r.key));
    return { key: step.key, done: input.done, progress: rules.progress(done, (p) => can(ctx.actor, p)) };
  });
}

/**
 * Leave the wizard for the app, with steps outstanding or not.
 *
 * A wizard that will not let go is a wizard people abandon. What matters is
 * that the company can take a booking, and the outstanding items stay on the
 * list at `/setup`, which stays open after this rather than redirecting.
 */
export async function finish(ctx: ServiceContext): Promise<{ setupCompletedAt: string }> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [org] = await tx.select({ at: schema.organization.setupCompletedAt }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    if (org?.at) return { setupCompletedAt: org.at.toISOString() };
    const at = new Date();
    await tx.update(schema.organization).set({ setupCompletedAt: at, updatedAt: at })
      .where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "setup.finished", "organization", ctx.actor.organizationId, null, { at });
    return { setupCompletedAt: at.toISOString() };
  });
}

/* ------------------------------------------------------- company details */

export interface CompanyDetails extends branding.CompanyContact {
  name: string;
  legalName: string | null;
  timezone: string;
}

type OrganizationRow = typeof schema.organization.$inferSelect;

const detailsOf = (org: OrganizationRow): CompanyDetails => ({
  name: org.name,
  legalName: org.legalName,
  timezone: org.timezone,
  ...contactColumns(org),
});

/** The contact columns of an organization row, as core's shape. */
const contactColumns = (org: Pick<OrganizationRow,
  "phone" | "email" | "addressLine1" | "addressLine2" | "city" | "state" | "postalCode">): branding.CompanyContact => ({
  phone: org.phone,
  email: org.email,
  addressLine1: org.addressLine1,
  addressLine2: org.addressLine2,
  city: org.city,
  state: org.state,
  postalCode: org.postalCode,
});

export async function details(ctx: ServiceContext): Promise<CompanyDetails> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const [org] = await tx.select().from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    if (!org) throw new NotFoundError("Company");
    return detailsOf(org);
  });
}

export type CompanyDetailsInput = {
  name: string;
  legalName?: string | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  postalCode?: string | null | undefined;
};

const CONTACT_KEYS = ["phone", "email", "addressLine1", "addressLine2", "city", "state", "postalCode"] as const;

/**
 * What customers call the company, what it is called on paper, and how a
 * customer reaches it.
 *
 * The name was written once, at sign up, and nothing could change it: a typo
 * typed at nine in the evening was on every invoice, every text and every
 * portal page for good. The legal name was a column nothing wrote at all.
 *
 * The legal name is what goes on a document that has legal weight (a lien
 * waiver, a contract) and is often not the name on the van, so the two are
 * separate and the legal one may be left empty until somebody knows it.
 * The time zone has its own control (`branding.setTimezone`), because what
 * changing it does is a different conversation.
 *
 * The phone, email and postal address are printed on the proposal, the
 * invoice, the statement, their PDFs and the portal's header. They are
 * checked together by `branding.checkContact`, which is where the rules live.
 * A field left out of the request keeps what it had, so a client that only
 * renames the company does not wipe its address; an empty string clears it.
 */
export async function updateDetails(
  ctx: ServiceContext, input: CompanyDetailsInput,
): Promise<CompanyDetails> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (name === "") throw new ConflictError("The company needs a name. It is on every invoice, text and page a customer sees.");
    if (name.length > 120) throw new ConflictError("Keep the name to a hundred and twenty characters. It has to fit on a text message.");
    const legalName = input.legalName === undefined ? undefined : (input.legalName?.trim() || null);
    if (legalName && legalName.length > 200) throw new ConflictError("Keep the legal name to two hundred characters.");

    const [before] = await tx.select().from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    if (!before) throw new NotFoundError("Company");

    /**
     * The contact is checked as a whole, after the fields left out are filled
     * from what is stored, so "an address needs a street and a town" is asked
     * of the address that will exist afterwards rather than of the request.
     */
    const current = contactColumns(before);
    const merged = { ...current };
    for (const key of CONTACT_KEYS) {
      if (input[key] !== undefined) merged[key] = input[key] ?? null;
    }
    const verdict = branding.checkContact(merged);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const [after] = await tx.update(schema.organization).set({
      name,
      ...(legalName !== undefined ? { legalName } : {}),
      ...verdict.contact,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId)).returning();

    await audit(tx, ctx, "organization.details_changed", "organization", ctx.actor.organizationId,
      { name: before.name, legalName: before.legalName, ...current },
      { name: after!.name, legalName: after!.legalName, ...contactColumns(after!) });
    return detailsOf(after!);
  });
}

/* ---------------------------------------------------------------- tax */

export interface TaxRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
  taxable: boolean;
  taxClass: string | null;
}

/** The tax classes a pack uses and the tax step offers. Free text on the version; these are the usual ones. */
export const TAX_CLASSES = ["labor", "material", "equipment", "service", "exempt"] as const;

/** Every live item with whether it is taxed and under which class, for the tax step. */
export async function taxTable(ctx: ServiceContext): Promise<TaxRow[]> {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const rows = await tx.select({
      id: schema.priceBookItem.id,
      code: schema.priceBookItem.code,
      name: schema.priceBookItemVersion.name,
      category: schema.priceBookCategory.name,
      taxable: schema.priceBookItemVersion.taxable,
      taxClass: schema.priceBookItemVersion.taxClass,
    }).from(schema.priceBookItem)
      .innerJoin(schema.priceBookItemVersion, and(
        eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id), inForceAt(),
      ))
      .leftJoin(schema.priceBookCategory, eq(schema.priceBookCategory.id, schema.priceBookItem.categoryId))
      .where(and(
        eq(schema.priceBookItem.organizationId, ctx.actor.organizationId),
        isNull(schema.priceBookItem.deletedAt),
        eq(schema.priceBookItem.active, true),
      ))
      .orderBy(sql`${schema.priceBookCategory.name} nulls last`, schema.priceBookItemVersion.name);
    return rows;
  });
}

/**
 * Set whether items are taxed, and their class, many at once.
 *
 * Through `reviseWithin`, a new version per item that changes, exactly as a
 * price change is: an invoice that charged tax on an item last month keeps
 * saying it did after the item is marked exempt today. Items already as asked
 * are left alone, so this does not mint a version of every item in a
 * category to change three of them.
 *
 * No rate here, deliberately. A rate is set on the document it is charged on,
 * because rates are the jurisdiction's and determining them is a thing this
 * project has decided not to build (BUILD.md). What an item can say is
 * whether it is taxable at all and which kind of thing it is.
 */
export async function setItemTax(
  ctx: ServiceContext, input: { itemIds: string[]; taxable: boolean; taxClass: string | null },
): Promise<{ changed: number }> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const seen = await replayed<{ changed: number }>(tx, ctx, "item_tax");
    if (seen) return seen;

    const ids = [...new Set(input.itemIds)];
    if (ids.length === 0) throw new ConflictError("Choose at least one item.");
    if (ids.length > 1000) throw new ConflictError("Change up to a thousand items at a time.");
    const taxClass = input.taxClass?.trim() || null;
    if (taxClass !== null && !(TAX_CLASSES as readonly string[]).includes(taxClass)) {
      throw new ConflictError(`"${taxClass}" is not a tax class. One of: ${TAX_CLASSES.join(", ")}.`);
    }
    if (taxClass === "exempt" && input.taxable) {
      throw new ConflictError("An exempt item is not taxable. Untick taxable, or choose another class.");
    }

    const now = new Date();
    const rows = await currentRows(tx, ids, now);
    if (rows.length !== ids.length) throw new NotFoundError("One of those items");

    let changed = 0;
    for (const row of rows) {
      if (row.version.taxable === input.taxable && (row.version.taxClass ?? null) === taxClass) continue;
      await reviseWithin(tx, ctx, row, { taxable: input.taxable, taxClass }, now);
      changed += 1;
    }
    const answer = { changed };
    await remember(tx, ctx, "item_tax", null, answer);
    return answer;
  });
}

async function currentRows(tx: Database, ids: string[], at: Date) {
  const rows = [];
  for (const id of ids) {
    const [row] = await tx.select({ item: schema.priceBookItem, version: schema.priceBookItemVersion })
      .from(schema.priceBookItem)
      .innerJoin(schema.priceBookItemVersion, and(
        eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id), inForceAt(at),
      ))
      .where(and(eq(schema.priceBookItem.id, id), isNull(schema.priceBookItem.deletedAt))).limit(1);
    if (row) rows.push(row);
  }
  return rows;
}

/* --------------------------------------------------------------- the facts */

type Org = typeof schema.organization.$inferSelect;

/**
 * What is already in place for each step, as sentences.
 *
 * Counts and states the company can see on other screens, read here so the
 * wizard can put them beside the step. Nothing secret: whether Stripe is
 * connected is not the key, and a count of items is not the items.
 */
async function factsFor(tx: Database, org: string, row: Org): Promise<Partial<Record<rules.SetupStepKey, string[]>>> {
  const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
  const n = sql<number>`count(*)::int`;

  const logo = await count(tx.select({ n }).from(schema.brandAsset)
    .where(and(eq(schema.brandAsset.organizationId, org), eq(schema.brandAsset.kind, "logo"))));
  const territories = await count(tx.select({ n }).from(schema.territory)
    .where(and(eq(schema.territory.organizationId, org), eq(schema.territory.active, true))));
  const hours = await count(tx.select({ n }).from(schema.businessHours)
    .where(and(eq(schema.businessHours.organizationId, org), eq(schema.businessHours.closed, false))));
  const windows = await count(tx.select({ n }).from(schema.arrivalWindow)
    .where(eq(schema.arrivalWindow.organizationId, org)));
  const holidays = await count(tx.select({ n }).from(schema.companyHoliday)
    .where(eq(schema.companyHoliday.organizationId, org)));
  const people = await count(tx.select({ n }).from(schema.membership)
    .where(and(eq(schema.membership.organizationId, org), eq(schema.membership.active, true))));
  const branches = await count(tx.select({ n }).from(schema.businessUnit)
    .where(and(eq(schema.businessUnit.organizationId, org), eq(schema.businessUnit.active, true))));

  const [book] = await tx.select({
    items: sql<number>`count(*)::int`,
    revised: sql<number>`(count(*) filter (where ${schema.priceBookItemVersion.version} > 1))::int`,
    taxable: sql<number>`(count(*) filter (where ${schema.priceBookItemVersion.taxable}))::int`,
    unclassed: sql<number>`(count(*) filter (where ${schema.priceBookItemVersion.taxable} and ${schema.priceBookItemVersion.taxClass} is null))::int`,
  }).from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, and(
      eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id), inForceAt(),
    ))
    .where(and(
      eq(schema.priceBookItem.organizationId, org),
      isNull(schema.priceBookItem.deletedAt),
      eq(schema.priceBookItem.active, true),
    ));

  /** The two rates by name, read off the items they point at. */
  const [rates] = await tx.select({
    afterHours: schema.afterHoursRate.afterHoursItemId,
    holiday: schema.afterHoursRate.holidayItemId,
  }).from(schema.afterHoursRate).where(eq(schema.afterHoursRate.organizationId, org)).limit(1);
  const itemName = async (id: string | null | undefined) => {
    if (!id) return null;
    const [item] = await tx.select({ code: schema.priceBookItem.code }).from(schema.priceBookItem)
      .where(eq(schema.priceBookItem.id, id)).limit(1);
    return item?.code ?? null;
  };
  const afterHoursCode = await itemName(rates?.afterHours);
  const holidayCode = await itemName(rates?.holiday);

  const connections = await tx.select({
    capability: schema.integrationConnection.capability,
    provider: schema.integrationConnection.provider,
    status: schema.integrationConnection.status,
  }).from(schema.integrationConnection)
    .where(eq(schema.integrationConnection.organizationId, org));
  const connected = (capability: string) => connections
    .filter((c) => c.capability === capability && c.status === "connected")
    .map((c) => providerName(c.provider));

  const brands = await tx.select({ status: schema.messagingBrand.status })
    .from(schema.messagingBrand).where(eq(schema.messagingBrand.organizationId, org));

  const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const items = book?.items ?? 0;

  return {
    company: [
      `Called ${row.name}${row.legalName && row.legalName !== row.name ? `, legally ${row.legalName}` : ""}.`,
      `Days run in ${row.timezone.replace(/_/g, " ")}.`,
      logo > 0 ? "A logo is set." : "No logo yet, so documents show the name.",
      branding.contactLines(contactColumns(row)).length > 0
        ? `Documents print ${branding.contactLines(contactColumns(row)).join(", ")}.`
        : "No phone, email or address, so documents give the customer no way to reach you.",
    ],
    trade: [row.primaryTrade ? `Running the ${row.primaryTrade.replace(/-/g, " ")} pack.` : "No trade pack applied."],
    "service-area": [territories > 0 ? `${plural(territories, "territory", "territories")} declared.` : "No territories, so no address has an area or a trip charge."],
    hours: [
      hours > 0 ? `Open ${plural(hours, "day")} a week.` : "No opening hours set.",
      windows > 0 ? `${plural(windows, "arrival window")} offered.` : "No arrival windows yet.",
      holidays > 0 ? `${plural(holidays, "holiday")} on the list.` : "No holidays on the list.",
    ],
    team: [
      `${plural(people, "person", "people")} can sign in.`,
      ...(branches > 0 ? [`${plural(branches, "branch", "branches")}.`] : []),
    ],
    pricebook: [
      items > 0 ? `${plural(items, "item")} on sale.` : "The price book is empty.",
      ...(items > 0 ? [`${plural(book?.revised ?? 0, "item")} changed since it was added.`] : []),
    ],
    tax: items > 0
      ? [
          `${plural(book?.taxable ?? 0, "item")} taxable, ${plural(items - (book?.taxable ?? 0), "item")} not.`,
          ...((book?.unclassed ?? 0) > 0 ? [`${plural(book!.unclassed, "taxable item")} with no class.`] : []),
        ]
      : ["Nothing in the price book to tax yet."],
    rates: [
      afterHoursCode ? `After hours, ${afterHoursCode} is offered.` : "No after hours rate chosen.",
      holidayCode ? `On a holiday, ${holidayCode} is offered.` : "No holiday rate chosen.",
    ],
    payments: [connected("payments").length > 0 ? `${connected("payments").join(", ")} connected.` : "No card processor connected."],
    communications: [
      connected("messaging").length > 0 ? `Texting through ${connected("messaging").join(", ")}.` : "No texting provider connected.",
      connected("email").length > 0 ? `Email through ${connected("email").join(", ")}.` : "No email provider connected.",
      brands.length === 0
        ? "No 10DLC registration recorded."
        : `10DLC brand ${brands.some((b) => b.status === "approved") ? "approved" : brands[0]!.status.replace(/_/g, " ")}.`,
    ],
    integrations: [connected("accounting").length > 0 ? `${connected("accounting").join(", ")} connected.` : "No accounting system connected."],
  };
}

const PROVIDERS: Record<string, string> = {
  stripe: "Stripe", quickbooks: "QuickBooks", xero: "Xero", twilio: "Twilio", justcall: "JustCall",
  resend: "Resend", smtp: "SMTP",
};
const providerName = (key: string) => PROVIDERS[key] ?? key;

/* --------------------------------------------------------------- handlers */

export const handlers = {
  getSetup: (ctx: ServiceContext) => view(ctx),
  markSetupStep: (ctx: ServiceContext, input: { key: string; done: boolean }) => mark(ctx, input),
  finishSetup: (ctx: ServiceContext) => finish(ctx),
  getCompanyDetails: (ctx: ServiceContext) => details(ctx),
  updateCompanyDetails: (ctx: ServiceContext, input: CompanyDetailsInput) => updateDetails(ctx, input),
  listItemTax: async (ctx: ServiceContext) => ({ items: await taxTable(ctx) }),
  setItemTax: (ctx: ServiceContext, input: { itemIds: string[]; taxable: boolean; taxClass: string | null }) =>
    setItemTax(ctx, input),
} as const;
