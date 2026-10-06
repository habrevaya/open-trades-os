import { eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { branding as brand, estimate as est, money as m } from "@opentradesos/core";
import { contactOf, guardedRead, type ServiceContext } from "./context";
import { assertEstimateVisible, loadEstimate } from "./estimates";
import { inGrant, peek, requireScope } from "./portal";
import { layoutWithin, proposalPhotoWithin, type ResolvedLayout } from "./proposal-templates";

/**
 * THE PROPOSAL, AS A DOCUMENT
 *
 * The customer read an estimate as a list on a web page: the options one
 * under another, no company on it, and nothing they could print and put on
 * the fridge or hand to the other person who has to say yes. A contractor
 * selling a fourteen thousand dollar system is competing with somebody who
 * left a printed, branded proposal on the kitchen table, and that document is
 * half the sale.
 *
 * This builds what the proposal page draws, for the office and for the
 * customer's own link, from ONE function, so the two can never show
 * different numbers: the company's name, logo and colour from Branding, the
 * options side by side with Good, Better and Best named by price, each line
 * with any member discount said on it, the terms copied onto the estimate
 * when it was written, and who signed and when.
 *
 * WHAT IS LEFT OUT IS LEFT OUT BY CONSTRUCTION. The shape is built field by
 * field from what a customer may see, exactly as the portal's own view is,
 * rather than by deleting cost and margin from the office view: a field
 * added to the office view later cannot reach a printed page because
 * somebody forgot a deletion.
 */

export interface ProposalLine {
  id: string;
  name: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  /** After any discount on the line, before tax. */
  lineTotal: string;
  discountAmount: string;
  /** How much of the discount was the customer's membership, and on which plan. */
  memberDiscountAmount: string;
  memberPlan: string | null;
  isOptional: boolean;
  isSelected: boolean;
}

export interface ProposalOption {
  id: string;
  name: string;
  description: string | null;
  /** Good, Better or Best by price when there are two or three options; null otherwise. */
  tier: est.Tier | null;
  isRecommended: boolean;
  /** Before any discount and before tax. */
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  /** Everything optional on this option that is not in the total. */
  optionalTotal: string;
  lines: ProposalLine[];
}

export interface ProposalDocument {
  company: {
    name: string;
    legalName: string | null;
    /** The company's colour as a fill, the text colour that reads on it, and a version safe as text. */
    color: string | null;
    on: string | null;
    text: string | null;
    hasLogo: boolean;
    /** Bumped when the logo changes, for the URL that serves it. */
    version: number;
    /** The company's calendar, for the dates on the page. */
    timezone: string;
    /** How the customer reaches the company, printed under its name. */
    contact: brand.CompanyContact;
  };
  id: string;
  number: number;
  title: string | null;
  status: string;
  issuedOn: string | null;
  expiresOn: string | null;
  decidedAt: string | null;
  signerName: string | null;
  selectedOptionId: string | null;
  customerName: string;
  propertyAddress: string;
  terms: string | null;
  /** In the order the customer is shown them: the recommended one first, then most expensive. */
  options: ProposalOption[];
  /**
   * How it is laid out: the company's template as copied onto this estimate,
   * or the fixed layout (the options, then the terms) when none was applied,
   * with the reviews and option photographs its sections show.
   */
  layout: ResolvedLayout;
}

const usd = (value: string) => m.money(value, "USD");

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;

/** The proposal, inside a transaction the caller holds and has authorised. */
export async function proposalWithin(
  tx: Database, ctx: ServiceContext, estimateId: string,
): Promise<ProposalDocument> {
  const full = await loadEstimate(tx, ctx, estimateId);

  const [org] = await tx.select({
    name: schema.organization.name,
    legalName: schema.organization.legalName,
    color: schema.organization.brandColor,
    timezone: schema.organization.timezone,
    updatedAt: schema.organization.updatedAt,
  }).from(schema.organization).where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
  const marks = await tx.select({ kind: schema.brandAsset.kind, updatedAt: schema.brandAsset.updatedAt })
    .from(schema.brandAsset);
  const color = org?.color ? brand.parseColor(org.color) : null;
  const latest = [org?.updatedAt, ...marks.map((a) => a.updatedAt)]
    .filter((at): at is Date => at instanceof Date)
    .reduce((max, at) => (at > max ? at : max), new Date(0));

  const [customer] = await tx.select({ name: schema.customer.name })
    .from(schema.customer).where(eq(schema.customer.id, full.customerId)).limit(1);
  const [property] = await tx.select({
    line1: schema.property.addressLine1,
    line2: schema.property.addressLine2,
    city: schema.property.city,
    state: schema.property.state,
    postalCode: schema.property.postalCode,
  }).from(schema.property).where(eq(schema.property.id, full.propertyId)).limit(1);

  type Line = Record<string, unknown>;
  const options = full.options as Array<Record<string, unknown>>;
  const agreementIds = [...new Set(options.flatMap((o) => (o["lines"] as Line[])
    .map((l) => l["memberAgreementId"] as string | null).filter((x): x is string => Boolean(x))))];
  const plans = agreementIds.length === 0 ? new Map<string, string>() : new Map(
    (await tx.select({ id: schema.agreement.id, planName: schema.agreementPlan.name })
      .from(schema.agreement)
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .where(inArray(schema.agreement.id, agreementIds)))
      .map((r) => [r.id, r.planName] as const),
  );

  const tiers = est.tierLabels(options.map((o) => usd(o["total"] as string)));
  const [stored] = await tx.select({ layout: schema.estimate.proposalLayout })
    .from(schema.estimate).where(eq(schema.estimate.id, estimateId)).limit(1);
  const layout = await layoutWithin(tx, estimateId, stored?.layout ?? null);

  return {
    company: {
      name: org?.name ?? "",
      legalName: org?.legalName ?? null,
      color,
      on: color ? brand.readableOn(color) : null,
      text: color ? brand.textSafe(color) : null,
      hasLogo: marks.some((a) => a.kind === "logo"),
      version: Math.floor(latest.getTime() / 1000),
      timezone: org?.timezone ?? "America/Chicago",
      contact: await contactOf(tx, ctx.actor.organizationId),
    },
    id: full.id,
    number: full.number,
    title: full.title ?? null,
    status: full.status,
    issuedOn: full.issuedOn ?? null,
    expiresOn: full.expiresOn ?? null,
    decidedAt: iso(full.decidedAt),
    signerName: full.signerName ?? null,
    selectedOptionId: full.selectedOptionId ?? null,
    customerName: customer?.name ?? "",
    propertyAddress: [
      property?.line1, property?.line2,
      [property?.city, [property?.state, property?.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    ].filter(Boolean).join(", "),
    terms: full.terms ?? null,
    layout,
    options: options.map((option, index) => {
      const subtotal = usd(option["subtotal"] as string);
      const taxTotal = usd(option["taxTotal"] as string);
      const total = usd(option["total"] as string);
      return {
        id: option["id"] as string,
        name: option["name"] as string,
        description: (option["description"] ?? null) as string | null,
        tier: tiers[index] ?? null,
        isRecommended: option["isRecommended"] as boolean,
        subtotal: m.toString(subtotal),
        /** What came off, worked back from the stored figures so it always reconciles to the total shown. */
        discountTotal: m.toString(m.subtract(m.add(subtotal, taxTotal), total)),
        taxTotal: m.toString(taxTotal),
        total: m.toString(total),
        optionalTotal: option["optionalTotal"] as string,
        lines: (option["lines"] as Line[]).map((line) => ({
          id: line["id"] as string,
          name: line["name"] as string,
          description: (line["description"] ?? null) as string | null,
          quantity: line["quantity"] as string,
          unitPrice: line["unitPrice"] as string,
          lineTotal: line["lineTotal"] as string,
          discountAmount: line["discountAmount"] as string,
          memberDiscountAmount: (line["memberDiscountAmount"] ?? "0") as string,
          memberPlan: line["memberAgreementId"] ? plans.get(line["memberAgreementId"] as string) ?? null : null,
          isOptional: line["isOptional"] as boolean,
          isSelected: line["isSelected"] as boolean,
        })),
      };
    }),
  };
}

/** The office's copy, to read, print or hand over. */
export async function proposal(ctx: ServiceContext, input: { id: string }): Promise<ProposalDocument> {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    await assertEstimateVisible(tx, ctx, input.id);
    return proposalWithin(tx, ctx, input.id);
  });
}

/**
 * One photograph the proposal shows, from the customer's own link: the cover
 * or one on an option of this estimate, and nothing else. Peeked like the
 * page, so looking does not spend the approval link.
 */
export async function proposalPhotoForToken(db: Database, token: string, photoId: string) {
  const grant = await peek(db, token);
  const estimateId = requireScope(grant, "estimate");
  return inGrant(db, grant, (tx) => proposalPhotoWithin(tx, estimateId, photoId));
}

/**
 * The customer's copy, from the link they were sent.
 *
 * Peeks at the grant rather than spending it, because printing the proposal
 * is reading it, and the single use on an estimate link is for approving.
 */
export async function proposalForToken(db: Database, token: string): Promise<ProposalDocument> {
  const grant = await peek(db, token);
  const estimateId = requireScope(grant, "estimate");
  return inGrant(db, grant, (tx, ctx) => proposalWithin(tx, ctx, estimateId));
}
