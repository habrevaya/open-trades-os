import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m, tax, time, SYSTEM_USER_ID } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf,
  ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { createTaxProvider } from "../tax";

/**
 * M13. THE COMPANY'S SALES TAX RATES, AND THE RATE A SALE IS CHARGED
 *
 * The rates are the company's own: a name, a percentage from a day, and which
 * one is usual. A customer or an address can name a different one, and a
 * customer can be exempt on a certificate (`customers.ts` writes both). Every
 * document that taxes something asks `saleRateWithin` here, through the tax
 * provider seam (`../tax`), and gets the same answer for the same sale: the
 * office's invoice, "Bill this job", an estimate, an invoice raised on the
 * phone or on `/my-day`. The decision itself is core's (`tax.resolve`).
 *
 * `settings:write` changes the rates, because what the company charges is a
 * company setting and the setup wizard's tax step already asks for it;
 * `settings:read` lists them. Every change is audited, and nothing is ever
 * removed: a rate is retired, because invoice lines name it.
 *
 * Tax collected by rate, for filing, is read from the ledger (`report`): each
 * document posts sales tax payable one entry per rate with the rate and the
 * sales it was charged on (`ledger.postInvoice`), so the report agrees with
 * the books by construction rather than by a reconciliation.
 */

/* ------------------------------------------------------------- reading */

/** The company's whole table, as core decides from it. One read per document. */
export async function tableWithin(tx: Database, organizationId: string): Promise<tax.TaxTable> {
  const [setting] = await tx.select().from(schema.taxSetting)
    .where(eq(schema.taxSetting.organizationId, organizationId)).limit(1);
  const rates = await tx.select().from(schema.taxRate)
    .where(eq(schema.taxRate.organizationId, organizationId))
    .orderBy(asc(schema.taxRate.name));
  const versions = rates.length === 0 ? [] : await tx.select().from(schema.taxRateVersion)
    .where(inArray(schema.taxRateVersion.taxRateId, rates.map((r) => r.id)))
    .orderBy(asc(schema.taxRateVersion.effectiveFrom));
  return {
    chargesTax: setting?.chargesTax ?? true,
    defaultRateId: setting?.defaultTaxRateId ?? null,
    rates: rates.map((r) => ({
      id: r.id,
      name: r.name,
      retired: r.retiredAt !== null,
      versions: versions.filter((v) => v.taxRateId === r.id)
        .map((v) => ({ rate: v.rate, effectiveFrom: v.effectiveFrom, parts: v.parts })),
    })),
  };
}

/**
 * A document's tax by rate, each row shared between the parts of its rate
 * when the company wrote that rate down in parts (`tax.withParts`), for
 * posting. `on` is the document's date, which picks the version whose parts
 * apply when a rate's percentage has had more than one split.
 *
 * Read as the document is posted, and never again: a void or a credit note
 * void takes back what the ledger says was posted (`billing.postedTaxByRate`),
 * parts included, so changing a rate's parts later cannot make a reversal
 * disagree with what it reverses.
 */
export async function withPartsWithin(
  tx: Database, organizationId: string, rows: readonly tax.RateTotal[], on: string,
): Promise<tax.RateTotal[]> {
  const ids = [...new Set(rows.map((r) => r.taxRateId).filter((x): x is string => x !== null))];
  if (ids.length === 0) return [...rows];
  const versions = await tx.select({
    taxRateId: schema.taxRateVersion.taxRateId, rate: schema.taxRateVersion.rate,
    effectiveFrom: schema.taxRateVersion.effectiveFrom, parts: schema.taxRateVersion.parts,
  }).from(schema.taxRateVersion)
    .where(and(eq(schema.taxRateVersion.organizationId, organizationId), inArray(schema.taxRateVersion.taxRateId, ids)));
  return rows.map((row) => row.taxRateId
    ? tax.withParts(row, tax.partsFor(versions.filter((v) => v.taxRateId === row.taxRateId), row.rate, on))
    : row);
}

/**
 * A sale as the provider is asked about it.
 *
 * `customerId` is whose work it is, which with the address decides the rate;
 * `payerId` is who the invoice is to, whose exemption decides whether it is
 * charged at all. They differ on a job billed to somebody else (a landlord
 * paying for a tenant's repair, a warranty company): the work is still at
 * the tenant's address and taxed at its rate, and it is the landlord's
 * certificate that would exempt it. Left off, the payer is the customer.
 */
export interface Sale {
  customerId: string;
  payerId?: string | undefined;
  propertyId: string | null;
  on: string;
}

/** Who is buying and where, as the provider is asked about it. */
export async function questionWithin(tx: Database, input: Sale): Promise<tax.TaxQuestion> {
  const read = async (id: string) => (await tx.select({
    taxExempt: schema.customer.taxExempt,
    certificate: schema.customer.taxExemptCertificate,
    expiresOn: schema.customer.taxExemptExpiresOn,
    taxRateId: schema.customer.taxRateId,
  }).from(schema.customer).where(eq(schema.customer.id, id)).limit(1))[0];
  const customer = await read(input.customerId);
  const payer = input.payerId && input.payerId !== input.customerId ? await read(input.payerId) : customer;
  const [property] = input.propertyId ? await tx.select({
    taxRateId: schema.property.taxRateId,
    line1: schema.property.addressLine1, city: schema.property.city, state: schema.property.state,
    postalCode: schema.property.postalCode, country: schema.property.country,
  }).from(schema.property).where(eq(schema.property.id, input.propertyId)).limit(1) : [];
  return {
    on: input.on,
    party: {
      exemption: {
        exempt: payer?.taxExempt ?? false,
        certificate: payer?.certificate ?? null,
        expiresOn: payer?.expiresOn ?? null,
      },
      customerRateId: customer?.taxRateId ?? null,
      addressRateId: property?.taxRateId ?? null,
    },
    address: property
      ? { line1: property.line1, city: property.city, state: property.state, postalCode: property.postalCode, country: property.country }
      : null,
  };
}

/**
 * The rate a sale to this customer at this address is charged on this day,
 * through the provider seam. `table` may be passed when the caller already
 * read it for the same document.
 */
export async function saleRateWithin(
  tx: Database, organizationId: string,
  input: Sale,
  table?: tax.TaxTable,
  /**
   * For a job billed in parts, where each payer's exemption is applied to
   * their own part and the job's rate is the address's whoever pays.
   */
  options: { ignoreExemption?: boolean } = {},
): Promise<tax.Resolved> {
  const loaded = table ?? await tableWithin(tx, organizationId);
  const provider = createTaxProvider("table", { table: loaded });
  const question = await questionWithin(tx, input);
  if (options.ignoreExemption) question.party.exemption = { exempt: false, certificate: null, expiresOn: null };
  return provider.rateFor(question);
}

/** The company's rates in force on a day, for a person picking one on a form. */
export interface RateChoice {
  id: string;
  name: string;
  rate: string;
  percent: string;
  label: string;
}

export function choicesOn(table: tax.TaxTable, on: string): RateChoice[] {
  return table.rates.flatMap((r) => {
    const rate = tax.rateOn(r, on);
    if (rate === null) return [];
    const canonical = tax.canonical(rate);
    return [{ id: r.id, name: r.name, rate: canonical, percent: tax.rateToPercent(canonical), label: tax.describe(r.name, canonical) }];
  });
}

/**
 * What a form needs to offer a rate: the company's rates in force today and
 * what this sale would be charged without anybody choosing. Read inside the
 * caller's permission (the invoice or estimate being written), so the office
 * can pick a rate without being able to change the company's settings.
 */
export async function pickerWithin(
  tx: Database, organizationId: string, sale: { customerId: string; propertyId: string | null } | null,
): Promise<{ today: string; choices: RateChoice[]; worked: tax.Resolved | null; chargesTax: boolean }> {
  const today = time.dateIn(new Date(), await timezoneOf(tx, organizationId));
  const table = await tableWithin(tx, organizationId);
  return {
    today,
    choices: choicesOn(table, today),
    worked: sale ? await saleRateWithin(tx, organizationId, { ...sale, on: today }, table) : null,
    chargesTax: table.chargesTax,
  };
}

/** The same, for a screen: the rates and this sale's rate, under the document's own read permission. */
export async function picker(
  ctx: ServiceContext,
  input: {
    customerId: string | null; propertyId: string | null;
    permission: "invoice:read" | "estimate:read" | "customer:read" | "property:read";
  },
) {
  return guardedRead(ctx, input.permission, (tx) => pickerWithin(tx, ctx.actor.organizationId,
    input.customerId ? { customerId: input.customerId, propertyId: input.propertyId } : null));
}

/* ------------------------------------------------------------ the list */

export interface TaxRateView {
  id: string;
  name: string;
  retired: boolean;
  isDefault: boolean;
  /** The percentage in force today, or null when it has none yet. */
  current: { rate: string; percent: string; effectiveFrom: string } | null;
  versions: Array<{
    id: string; rate: string; percent: string; effectiveFrom: string; note: string | null;
    state: "past" | "current" | "scheduled";
    /** The jurisdictions the percentage is made of, when it was written down in parts. */
    parts: RatePartView[];
  }>;
  /** How many customers and addresses name it, so retiring it is not a surprise. */
  customers: number;
  addresses: number;
}

export interface RatePartView {
  name: string;
  rate: string;
  percent: string;
}

const partViews = (parts: readonly tax.RatePart[]): RatePartView[] =>
  parts.map((p) => ({ name: p.name, rate: tax.canonical(p.rate), percent: tax.rateToPercent(p.rate) }));

export interface TaxSettingsView {
  today: string;
  chargesTax: boolean;
  /** Whether anybody has answered yet. A company that has not is charged only where a rate is named. */
  answered: boolean;
  defaultTaxRateId: string | null;
  rates: TaxRateView[];
}

export async function list(ctx: ServiceContext): Promise<TaxSettingsView> {
  return guardedRead(ctx, "settings:read", (tx) => viewWithin(tx, ctx.actor.organizationId));
}

async function viewWithin(tx: Database, organizationId: string): Promise<TaxSettingsView> {
  const today = time.dateIn(new Date(), await timezoneOf(tx, organizationId));
  const [setting] = await tx.select().from(schema.taxSetting)
    .where(eq(schema.taxSetting.organizationId, organizationId)).limit(1);
  const rates = await tx.select().from(schema.taxRate)
    .where(eq(schema.taxRate.organizationId, organizationId))
    .orderBy(sql`${schema.taxRate.retiredAt} is not null`, asc(schema.taxRate.name));
  const versions = rates.length === 0 ? [] : await tx.select().from(schema.taxRateVersion)
    .where(inArray(schema.taxRateVersion.taxRateId, rates.map((r) => r.id)))
    .orderBy(asc(schema.taxRateVersion.effectiveFrom));
  const counts = async (table: typeof schema.customer | typeof schema.property) => new Map(
    (await tx.select({ id: table.taxRateId, n: sql<number>`count(*)::int` }).from(table)
      .where(and(eq(table.organizationId, organizationId), isNull(table.deletedAt), sql`${table.taxRateId} is not null`))
      .groupBy(table.taxRateId)).map((r) => [r.id!, Number(r.n)]),
  );
  const customerCounts = await counts(schema.customer);
  const addressCounts = await counts(schema.property);

  return {
    today,
    chargesTax: setting?.chargesTax ?? true,
    answered: setting !== undefined,
    defaultTaxRateId: setting?.defaultTaxRateId ?? null,
    rates: rates.map((r) => {
      const mine = versions.filter((v) => v.taxRateId === r.id);
      const current = tax.versionOn(mine, today);
      return {
        id: r.id,
        name: r.name,
        retired: r.retiredAt !== null,
        isDefault: setting?.defaultTaxRateId === r.id,
        current: current && r.retiredAt === null
          ? { rate: tax.canonical(current.rate), percent: tax.rateToPercent(current.rate), effectiveFrom: current.effectiveFrom }
          : null,
        versions: mine.map((v) => ({
          id: v.id,
          rate: tax.canonical(v.rate),
          percent: tax.rateToPercent(v.rate),
          effectiveFrom: v.effectiveFrom,
          note: v.note,
          parts: partViews(v.parts),
          state: v.effectiveFrom > today ? "scheduled" as const
            : current && v.effectiveFrom === current.effectiveFrom ? "current" as const : "past" as const,
        })),
        customers: customerCounts.get(r.id) ?? 0,
        addresses: addressCounts.get(r.id) ?? 0,
      };
    }),
  };
}

/* ------------------------------------------------------------ changing */

function percentOrRefuse(percent: string, path: string): string {
  const checked = tax.percentToRate(percent);
  if (!checked.ok) throw new UnprocessableError("That is not a rate", [{ path, message: checked.reason }]);
  return checked.rate;
}

/** A part as it is typed: a jurisdiction's name and its percentage, "Texas" and "6.25". */
export interface PartInput { name: string; percent: string }

/**
 * The rate a version charges and the parts it is made of. With parts, the
 * rate is their sum, and a whole percentage typed beside them must be that
 * sum; without, the percentage is the rate, as it always was.
 */
function rateOrRefuse(
  input: { percent?: string | undefined; parts?: readonly PartInput[] | undefined },
): { rate: string; parts: tax.RatePart[] } {
  if (input.parts && input.parts.length > 0) {
    const checked = tax.checkParts(input.parts, input.percent);
    if (!checked.ok) throw new UnprocessableError("Those parts are not a rate", [{ path: "parts", message: checked.reason }]);
    return { rate: checked.rate, parts: checked.parts };
  }
  if (!input.percent || input.percent.trim() === "") {
    throw new UnprocessableError("A rate needs a percent", [{ path: "percent", message: "Give the percent, like 8.25, or its parts." }]);
  }
  return { rate: percentOrRefuse(input.percent, "percent"), parts: [] };
}

/** Whether two versions were written down in the same parts, in the same order. */
const sameParts = (a: readonly tax.RatePart[], b: readonly tax.RatePart[]): boolean =>
  a.length === b.length && a.every((p, i) => p.name === b[i]!.name && tax.sameRate(p.rate, b[i]!.rate));

function dateOrRefuse(date: string, path: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new UnprocessableError("That is not a date", [{ path, message: "The date it starts is a calendar date." }]);
  }
}

async function settingWithin(tx: Database, organizationId: string) {
  const [row] = await tx.select().from(schema.taxSetting)
    .where(eq(schema.taxSetting.organizationId, organizationId)).limit(1);
  return row ?? null;
}

/**
 * A new rate, with its percentage from a day.
 *
 * A second live rate with the same name is refused in words rather than left
 * to `tax_rate_name_idx`. The same name and percentage sent again is the same
 * request retried, and returns the rate already there.
 */
export interface CreateRateInput {
  name: string;
  percent?: string | undefined;
  parts?: readonly PartInput[] | undefined;
  effectiveFrom?: string | undefined;
  makeDefault?: boolean | undefined;
}

export async function create(ctx: ServiceContext, input: CreateRateInput): Promise<TaxSettingsView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const name = input.name.trim();
    if (name === "") throw new UnprocessableError("A rate needs a name", [{ path: "name", message: "Name it, like Travis County." }]);
    const { rate, parts } = rateOrRefuse(input);
    const effectiveFrom = input.effectiveFrom ?? time.dateIn(new Date(), await timezoneOf(tx, org));
    dateOrRefuse(effectiveFrom, "effectiveFrom");

    const [clash] = await tx.select().from(schema.taxRate)
      .where(and(eq(schema.taxRate.organizationId, org), isNull(schema.taxRate.retiredAt),
        sql`lower(${schema.taxRate.name}) = lower(${name})`)).limit(1);
    if (clash) {
      const [same] = await tx.select().from(schema.taxRateVersion)
        .where(and(eq(schema.taxRateVersion.taxRateId, clash.id), eq(schema.taxRateVersion.effectiveFrom, effectiveFrom)))
        .limit(1);
      if (!same || !tax.sameRate(same.rate, rate) || !sameParts(same.parts, parts)) {
        throw new ConflictError(`There is already a rate called ${clash.name}. Give its new percentage a date on it instead.`);
      }
    } else {
      const [row] = await tx.insert(schema.taxRate).values({ organizationId: org, name }).returning();
      const [version] = await tx.insert(schema.taxRateVersion).values({
        organizationId: org, taxRateId: row!.id, rate, parts, effectiveFrom,
        createdByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      }).returning();
      await audit(tx, ctx, "tax.rate_created", "tax_rate", row!.id, null, { ...row!, version: version! });
    }

    const id = clash?.id ?? (await tx.select({ id: schema.taxRate.id }).from(schema.taxRate)
      .where(and(eq(schema.taxRate.organizationId, org), isNull(schema.taxRate.retiredAt),
        sql`lower(${schema.taxRate.name}) = lower(${name})`)).limit(1))[0]!.id;
    const setting = await settingWithin(tx, org);
    if (input.makeDefault || (!setting?.defaultTaxRateId && !clash)) {
      await writeSetting(tx, ctx, { chargesTax: setting?.chargesTax ?? true, defaultTaxRateId: id }, setting);
    }
    return viewWithin(tx, org);
  });
}

/**
 * A rate's new percentage from a day: the county raising its rate on the
 * first. Every document already written keeps what it charged; a draft
 * issued on or after the day is checked against it.
 */
export interface AddVersionInput {
  id: string;
  percent?: string | undefined;
  parts?: readonly PartInput[] | undefined;
  effectiveFrom: string;
  note?: string | undefined;
}

export async function addVersion(ctx: ServiceContext, input: AddVersionInput): Promise<TaxSettingsView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const row = await rateWithin(tx, org, input.id);
    if (row.retiredAt) throw new ConflictError(`${row.name} is retired. Add a new rate instead.`);
    const { rate, parts } = rateOrRefuse(input);
    dateOrRefuse(input.effectiveFrom, "effectiveFrom");

    const [clash] = await tx.select().from(schema.taxRateVersion)
      .where(and(eq(schema.taxRateVersion.taxRateId, row.id), eq(schema.taxRateVersion.effectiveFrom, input.effectiveFrom)))
      .limit(1);
    if (clash && tax.sameRate(clash.rate, rate) && sameParts(clash.parts, parts)) return viewWithin(tx, org);
    if (clash) {
      throw new ConflictError(
        `${row.name} already has a percentage from ${input.effectiveFrom}. Start the new one on a different day.`,
      );
    }
    const [version] = await tx.insert(schema.taxRateVersion).values({
      organizationId: org, taxRateId: row.id, rate, parts, effectiveFrom: input.effectiveFrom,
      note: input.note?.trim() || null,
      createdByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    }).returning();
    await tx.update(schema.taxRate).set({ updatedAt: new Date() }).where(eq(schema.taxRate.id, row.id));
    await audit(tx, ctx, "tax.rate_changed", "tax_rate", row.id, null, version!);
    return viewWithin(tx, org);
  });
}

/**
 * Take a rate out of use. Lines that charged it keep naming it; customers and
 * addresses that named it are charged the default from now on, which the
 * screen says beside the button. The default cannot be retired: choose
 * another first, or say the company charges none.
 */
export async function retire(ctx: ServiceContext, input: { id: string }): Promise<TaxSettingsView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const row = await rateWithin(tx, org, input.id);
    if (row.retiredAt) return viewWithin(tx, org);
    const setting = await settingWithin(tx, org);
    if (setting?.defaultTaxRateId === row.id) {
      throw new ConflictError(`${row.name} is the usual rate. Make another rate the usual one before retiring it.`);
    }
    const [after] = await tx.update(schema.taxRate).set({ retiredAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.taxRate.id, row.id)).returning();
    await audit(tx, ctx, "tax.rate_retired", "tax_rate", row.id, row, after!);
    return viewWithin(tx, org);
  });
}

/** Whether the company charges sales tax at all, and its usual rate. */
export async function updateSettings(
  ctx: ServiceContext,
  input: { chargesTax?: boolean | undefined; defaultTaxRateId?: string | null | undefined },
): Promise<TaxSettingsView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const setting = await settingWithin(tx, org);
    if (input.defaultTaxRateId) {
      const row = await rateWithin(tx, org, input.defaultTaxRateId);
      if (row.retiredAt) throw new ConflictError(`${row.name} is retired, so it cannot be the usual rate.`);
    }
    await writeSetting(tx, ctx, {
      chargesTax: input.chargesTax ?? setting?.chargesTax ?? true,
      defaultTaxRateId: input.defaultTaxRateId !== undefined ? input.defaultTaxRateId : setting?.defaultTaxRateId ?? null,
    }, setting);
    return viewWithin(tx, org);
  });
}

async function writeSetting(
  tx: Database, ctx: ServiceContext,
  next: { chargesTax: boolean; defaultTaxRateId: string | null },
  before: typeof schema.taxSetting.$inferSelect | null,
): Promise<void> {
  const [after] = await tx.insert(schema.taxSetting).values({
    organizationId: ctx.actor.organizationId, ...next,
  }).onConflictDoUpdate({
    target: schema.taxSetting.organizationId,
    set: { ...next, updatedAt: new Date() },
  }).returning();
  await audit(tx, ctx, "tax.settings_changed", "tax_setting", after!.id, before, after!);
}

async function rateWithin(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.taxRate)
    .where(and(eq(schema.taxRate.id, id), eq(schema.taxRate.organizationId, organizationId))).limit(1);
  if (!row) throw new NotFoundError("Tax rate");
  return row;
}

/** A rate named on a customer or an address must be one of this company's, and in use. */
export async function assertUsable(tx: Database, organizationId: string, id: string | null | undefined, path: string): Promise<void> {
  if (!id) return;
  const [row] = await tx.select().from(schema.taxRate)
    .where(and(eq(schema.taxRate.id, id), eq(schema.taxRate.organizationId, organizationId))).limit(1);
  if (!row) throw new UnprocessableError("No such tax rate", [{ path, message: "Choose one of the company's tax rates." }]);
  if (row.retiredAt) throw new UnprocessableError("That rate is retired", [{ path, message: `${row.name} is retired. Choose a rate in use.` }]);
}

/* --------------------------------------------------- tax by rate, filed */

/** What the ledger says each document was, for the report's own grouping. */
const SALES_SOURCES = ["invoice", "void", "credit_note", "credit_note_void", "agreement_billing"] as const;

export interface SalesTaxRow {
  taxRateId: string | null;
  /** The rate's name today, or what the row is when it is not one of the company's. */
  name: string;
  rate: string | null;
  percent: string | null;
  /** Sales the rate was charged on, net of voids and credits. */
  taxableSales: string;
  /** Tax charged, net of voids and credits. */
  taxCollected: string;
}

/** Tax collected for one jurisdiction, from the rates written down in parts. */
export interface SalesTaxPartRow {
  /** The part's name ("Texas"), or the rate's name for tax from a rate written as one figure. */
  name: string;
  /** False for a rate written as one figure, which cannot be put on a jurisdiction. */
  inParts: boolean;
  rate: string | null;
  percent: string | null;
  taxableSales: string;
  taxCollected: string;
}

export interface SalesTaxReport {
  from: string;
  to: string;
  rows: SalesTaxRow[];
  /**
   * The same tax by jurisdiction: each part of a rate written down in parts,
   * the same part on several rates on one row, and a rate written as one
   * figure on a row of its own. Adds up to `totalCollected`.
   */
  byPart: SalesTaxPartRow[];
  totalCollected: string;
  /**
   * Everything else that moved sales tax payable in the period: a payment to
   * the state or a correction, journalled by hand. Shown so the report
   * reconciles to the account rather than leaving the difference unexplained.
   */
  otherMovements: string;
  /** Sales tax payable's movement in the period: collected plus the rest. */
  accountMovement: string;
}

/**
 * SALES TAX COLLECTED, BY RATE, FOR A PERIOD.
 *
 * Read from the ledger, which is what every financial report here reads:
 * each sales document's entries on sales tax payable, credits as collected
 * and debits (a void, a credit note) as given back, grouped by the rate the
 * entry carries. A document posted before rates were recorded on the ledger
 * is a row of its own rather than guessed onto a rate; an agreement's
 * instalment posts by rate like an invoice and lands on its rate. Days are
 * the company's.
 *
 * And by jurisdiction (`byPart`): a rate written down in parts posted an
 * entry per part, each naming its jurisdiction, so the state's share of
 * every rate is one row however many rates include it. Tax from a rate
 * written as one figure cannot be put on a jurisdiction and is shown under
 * the rate's own name, so the jurisdiction rows still add up to the total.
 */
export async function report(ctx: ServiceContext, input: { from: string; to: string }): Promise<SalesTaxReport> {
  return guardedRead(ctx, "report.financial:read", async (tx) => {
    dateOrRefuse(input.from, "from");
    dateOrRefuse(input.to, "to");
    if (input.to < input.from) {
      throw new UnprocessableError("The period ends before it starts", [{ path: "to", message: "Choose an end on or after the start." }]);
    }
    const org = ctx.actor.organizationId;
    const zone = await timezoneOf(tx, org);
    const start = time.startOfDayIn(input.from, zone);
    const end = time.startOfDayIn(time.nextDay(input.to), zone);

    const signed = sql<string>`sum(case when ${schema.ledgerEntry.direction} = 'credit' then ${schema.ledgerEntry.amount} else -${schema.ledgerEntry.amount} end)`;
    const base = sql<string>`sum(case when ${schema.ledgerEntry.direction} = 'credit' then 1 else -1 end * coalesce((${schema.ledgerEntry.metadata}->>'taxableBase')::numeric, 0))`;
    const inPeriod = and(
      eq(schema.ledgerEntry.organizationId, org),
      eq(schema.ledgerEntry.accountCode, ledger.ACCOUNTS.TAX_PAYABLE),
      gte(schema.ledgerEntry.occurredAt, start),
      lt(schema.ledgerEntry.occurredAt, end),
    );

    const grouped = await tx.select({
      taxRateId: sql<string | null>`${schema.ledgerEntry.metadata}->>'taxRateId'`,
      rate: sql<string | null>`${schema.ledgerEntry.metadata}->>'taxRate'`,
      collected: signed,
      base,
    }).from(schema.ledgerEntry)
      .where(and(inPeriod, inArray(schema.ledgerEntry.sourceType, [...SALES_SOURCES])))
      .groupBy(sql`1`, sql`2`);

    const [other] = await tx.select({ total: signed }).from(schema.ledgerEntry)
      .where(and(inPeriod, sql`${schema.ledgerEntry.sourceType} not in (${sql.join(SALES_SOURCES.map((s) => sql`${s}`), sql`, `)})`));

    /** The same entries by jurisdiction, for the rates written down in parts. */
    const partBase = sql<string>`sum(case when ${schema.ledgerEntry.direction} = 'credit' then 1 else -1 end * coalesce((${schema.ledgerEntry.metadata}->>'partBase')::numeric, (${schema.ledgerEntry.metadata}->>'taxableBase')::numeric, 0))`;
    const byPartGrouped = await tx.select({
      part: sql<string | null>`${schema.ledgerEntry.metadata}->>'part'`,
      partRate: sql<string | null>`${schema.ledgerEntry.metadata}->>'partRate'`,
      taxRateId: sql<string | null>`${schema.ledgerEntry.metadata}->>'taxRateId'`,
      rate: sql<string | null>`${schema.ledgerEntry.metadata}->>'taxRate'`,
      collected: signed,
      base: partBase,
    }).from(schema.ledgerEntry)
      .where(and(inPeriod, inArray(schema.ledgerEntry.sourceType, [...SALES_SOURCES])))
      .groupBy(sql`1`, sql`2`, sql`3`, sql`4`);

    const ids = [...new Set([...grouped, ...byPartGrouped].map((g) => g.taxRateId).filter((x): x is string => x !== null))];
    const names = ids.length === 0 ? new Map<string, string>() : new Map(
      (await tx.select({ id: schema.taxRate.id, name: schema.taxRate.name }).from(schema.taxRate)
        .where(inArray(schema.taxRate.id, ids))).map((r) => [r.id, r.name]),
    );

    const usd = (v: string | null | undefined) => m.money(v ?? "0", "USD");
    const rows: SalesTaxRow[] = grouped
      .filter((g) => !m.isZero(usd(g.collected)) || !m.isZero(usd(g.base)))
      .map((g) => ({
        taxRateId: g.taxRateId,
        name: g.taxRateId ? names.get(g.taxRateId) ?? "A rate since removed"
          : g.rate ? "Typed by hand or recorded from another system" : "Not recorded by rate",
        rate: g.rate,
        percent: g.rate ? tax.rateToPercent(g.rate) : null,
        taxableSales: m.toString(m.round(usd(g.base), 2)),
        taxCollected: m.toString(usd(g.collected)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || Number(a.rate ?? 0) - Number(b.rate ?? 0));

    const rateName = (taxRateId: string | null, rate: string | null) => taxRateId
      ? names.get(taxRateId) ?? "A rate since removed"
      : rate ? "Typed by hand or recorded from another system" : "Not recorded by rate";
    const parts = new Map<string, { name: string; inParts: boolean; rate: string | null; base: m.Money; collected: m.Money }>();
    for (const g of byPartGrouped) {
      const inParts = g.part !== null;
      const key = inParts ? `part|${g.part!.toLowerCase()}|${g.partRate ?? ""}` : `rate|${g.taxRateId ?? ""}|${g.rate ?? ""}`;
      const at = parts.get(key) ?? {
        name: inParts ? g.part! : rateName(g.taxRateId, g.rate),
        inParts, rate: inParts ? g.partRate : g.rate, base: m.zero("USD"), collected: m.zero("USD"),
      };
      at.base = m.add(at.base, usd(g.base));
      at.collected = m.add(at.collected, usd(g.collected));
      parts.set(key, at);
    }
    const byPart: SalesTaxPartRow[] = [...parts.values()]
      .filter((p) => !m.isZero(p.collected) || !m.isZero(p.base))
      .map((p) => ({
        name: p.name, inParts: p.inParts, rate: p.rate, percent: p.rate ? tax.rateToPercent(p.rate) : null,
        taxableSales: m.toString(m.round(p.base, 2)), taxCollected: m.toString(p.collected),
      }))
      .sort((a, b) => Number(b.inParts) - Number(a.inParts) || a.name.localeCompare(b.name)
        || Number(a.rate ?? 0) - Number(b.rate ?? 0));

    const collected = m.sum(rows.map((r) => usd(r.taxCollected)), "USD");
    const others = usd(other?.total);
    return {
      from: input.from,
      to: input.to,
      rows,
      byPart,
      totalCollected: m.toString(collected),
      otherMovements: m.toString(others),
      accountMovement: m.toString(m.add(collected, others)),
    };
  });
}

/* ------------------------------------------------------------ handlers */

export const handlers = {
  listTaxRates: (ctx: ServiceContext) => list(ctx),
  createTaxRate: (ctx: ServiceContext, input: CreateRateInput) => create(ctx, input),
  addTaxRateVersion: (ctx: ServiceContext, input: AddVersionInput) => addVersion(ctx, input),
  retireTaxRate: (ctx: ServiceContext, input: { id: string }) => retire(ctx, input),
  updateTaxSettings: (ctx: ServiceContext, input: { chargesTax?: boolean | undefined; defaultTaxRateId?: string | null | undefined }) =>
    updateSettings(ctx, input),
  getSalesTaxReport: (ctx: ServiceContext, input: { from: string; to: string }) => report(ctx, input),
} as const;
