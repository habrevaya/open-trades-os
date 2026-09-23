import { type Money, add, subtract, multiply, min, zero, isNegative } from "../money/index.js";

/**
 * WHO IS PAYING FOR THIS, AND WHY
 *
 * Separate from the party model, which answers WHO. This answers why it is
 * free, or cheaper, or billed to somebody else, and the research this project
 * started from called it the single most load-bearing missing concept in the
 * products contractors already use.
 *
 * The distinction that matters most: a zero dollar visit under an agreement
 * and a zero dollar visit that is our own rework look identical on a revenue
 * report and mean opposite things about the business. One is a plan being
 * delivered, which is why the company is worth what it is. The other is work
 * being done twice, which is a cost with a cause somebody could fix.
 *
 * Everything here is a pure function of a resolved entitlement and an amount.
 * No database, no clock. The resolution is recorded rather than derived on
 * read, because the inputs change and the record must not: a warranty that
 * expires next month did not expire on the visit it covered.
 */

export type CoverageSource =
  | "customer"
  | "agreement"
  | "parts_warranty"
  | "labour_warranty"
  | "our_warranty"
  | "home_warranty"
  | "insurance"
  | "goodwill"
  | "no_charge_callback"
  | "contract";

/** What a line of work is, for the purpose of who pays for it. */
export type ChargeKind = "labour" | "parts" | "trip" | "other";

export interface CoverageProfile {
  label: string;
  /** One sentence an office manager would recognise. */
  description: string;
  coversLabour: boolean;
  coversParts: boolean;
  coversTrip: boolean;
  /**
   * Whether somebody other than the customer is invoiced for the covered
   * part. A manufacturer and a home warranty administrator get billed; our
   * own callback and goodwill are costs we absorb, and the difference is the
   * whole of "what does rework cost us".
   */
  billsAThirdParty: boolean;
  /**
   * Whether the company chose to absorb this rather than being obliged to.
   * Goodwill is a decision and should be reportable as one; a warranty is
   * not a decision.
   */
  isAConcession: boolean;
}

/**
 * The defaults for each source, which are what an office manager expects
 * before anybody edits anything.
 *
 * A parts warranty covers the part and not the labour, and a labour warranty
 * is the other way round: those two are the ones people get backwards, and
 * getting them backwards bills a customer for something a manufacturer owed.
 */
export const COVERAGE: Record<CoverageSource, CoverageProfile> = {
  customer: {
    label: "The customer",
    description: "They pay, at our price. The ordinary case.",
    coversLabour: false, coversParts: false, coversTrip: false,
    billsAThirdParty: false, isAConcession: false,
  },
  agreement: {
    label: "Their maintenance plan",
    description: "Included in a plan they already pay for, so the visit bills nothing and the revenue is recognised on the agreement.",
    coversLabour: true, coversParts: false, coversTrip: true,
    billsAThirdParty: false, isAConcession: false,
  },
  parts_warranty: {
    label: "Parts warranty",
    description: "The manufacturer pays for the part. The customer pays the labour.",
    coversLabour: false, coversParts: true, coversTrip: false,
    billsAThirdParty: true, isAConcession: false,
  },
  labour_warranty: {
    label: "Labour warranty",
    description: "The labour is covered. The part is not.",
    coversLabour: true, coversParts: false, coversTrip: false,
    billsAThirdParty: true, isAConcession: false,
  },
  our_warranty: {
    label: "Our own warranty",
    description: "We stand behind our work. Nobody is billed and it costs us.",
    coversLabour: true, coversParts: true, coversTrip: true,
    billsAThirdParty: false, isAConcession: false,
  },
  home_warranty: {
    label: "A home warranty administrator",
    description: "They pay a rate card. The customer pays a trade call fee.",
    coversLabour: true, coversParts: true, coversTrip: false,
    billsAThirdParty: true, isAConcession: false,
  },
  insurance: {
    label: "An insurance carrier",
    description: "The carrier pays most of it. The customer pays their deductible.",
    coversLabour: true, coversParts: true, coversTrip: true,
    billsAThirdParty: true, isAConcession: false,
  },
  goodwill: {
    label: "Goodwill",
    description: "We chose to absorb it. A decision, and reportable as one.",
    coversLabour: true, coversParts: true, coversTrip: true,
    billsAThirdParty: false, isAConcession: true,
  },
  no_charge_callback: {
    label: "Rework on our own work",
    description: "We are back because of something we did. This must never be billed.",
    coversLabour: true, coversParts: true, coversTrip: true,
    billsAThirdParty: false, isAConcession: false,
  },
  contract: {
    label: "A service contract",
    description: "Covered by a commercial contract, usually at its own rate card.",
    coversLabour: true, coversParts: true, coversTrip: false,
    billsAThirdParty: true, isAConcession: false,
  },
};

export const SOURCES = Object.keys(COVERAGE) as CoverageSource[];

/** The terms actually resolved for one visit, which may differ from the defaults. */
export interface Entitlement {
  source: CoverageSource;
  coversLabour: boolean;
  coversParts: boolean;
  coversTrip: boolean;
  /** Where the source pays a share rather than all of it. `"0.8000"` is 80%. */
  coveragePercent?: string | null;
  /** A ceiling on what the source pays, across the whole visit. */
  coverageLimit?: Money | null;
  /** What the customer owes regardless: a deductible, a trade call fee. */
  customerResponsibility?: Money | null;
}

/** An entitlement with the source's defaults filled in. */
export function withDefaults(
  source: CoverageSource,
  over: Partial<Entitlement> = {},
): Entitlement {
  const profile = COVERAGE[source];
  return {
    source,
    coversLabour: over.coversLabour ?? profile.coversLabour,
    coversParts: over.coversParts ?? profile.coversParts,
    coversTrip: over.coversTrip ?? profile.coversTrip,
    ...(over.coveragePercent !== undefined ? { coveragePercent: over.coveragePercent } : {}),
    ...(over.coverageLimit !== undefined ? { coverageLimit: over.coverageLimit } : {}),
    ...(over.customerResponsibility !== undefined
      ? { customerResponsibility: over.customerResponsibility } : {}),
  };
}

function covers(entitlement: Entitlement, kind: ChargeKind): boolean {
  switch (kind) {
    case "labour": return entitlement.coversLabour;
    case "parts": return entitlement.coversParts;
    case "trip": return entitlement.coversTrip;
    /**
     * Anything we could not classify is the customer's. Guessing the other
     * way means a line quietly billed to nobody, and a line billed to nobody
     * is revenue that silently disappears.
     */
    case "other": return false;
  }
}

export interface Charge {
  kind: ChargeKind;
  amount: Money;
}

export interface Split {
  /** What the customer is invoiced. */
  customer: Money;
  /** What the coverage source is responsible for. */
  covered: Money;
}

/**
 * Split one visit's charges between the customer and whoever is covering it.
 *
 * Whole visit rather than line by line, because the two things that make this
 * hard are both properties of the visit: a coverage LIMIT is a ceiling on the
 * total, and a customer RESPONSIBILITY, a deductible or a trade call fee, is
 * charged once no matter how many lines there are. Splitting line by line and
 * adding a deductible to each one is how a customer gets charged their
 * excess four times.
 *
 * Order matters and is deliberate:
 *
 *   1. Only the kinds the source actually covers are in scope. A parts
 *      warranty seeing a labour line has nothing to say about it.
 *   2. The percentage applies to what is in scope.
 *   3. The limit caps what the source pays. Anything above it falls back to
 *      the customer, which is what a cap means.
 *   4. The customer responsibility is added last, once, and never pushes
 *      what the customer owes above the total. A deductible larger than the
 *      job is the customer paying for the whole job, not more than it.
 */
export function split(entitlement: Entitlement, charges: Charge[]): Split {
  const currency = charges[0]?.amount.currency ?? "USD";
  const total = charges.reduce((sum, c) => add(sum, c.amount), zero(currency));

  const inScope = charges
    .filter((c) => covers(entitlement, c.kind))
    .reduce((sum, c) => add(sum, c.amount), zero(currency));

  let covered = entitlement.coveragePercent
    ? multiply(inScope, entitlement.coveragePercent)
    : inScope;

  if (entitlement.coverageLimit) covered = min(covered, entitlement.coverageLimit);

  let customer = subtract(total, covered);

  const responsibility = entitlement.customerResponsibility;
  if (responsibility) {
    /**
     * Taken out of the covered amount rather than added on top. A deductible
     * is the first part of the bill the customer pays, not a surcharge: a
     * five hundred dollar job with a hundred dollar deductible costs the
     * customer a hundred, not six hundred.
     */
    const shift = min(responsibility, covered);
    covered = subtract(covered, shift);
    customer = add(customer, shift);
  }

  // Nothing here can go negative, and a negative on either side would be a
  // credit note nobody asked for.
  return {
    customer: isNegative(customer) ? zero(currency) : customer,
    covered: isNegative(covered) ? zero(currency) : covered,
  };
}

/**
 * Whether this coverage means the work was free BECAUSE WE GOT IT WRONG.
 *
 * The number nobody has and everybody needs: what rework and concessions
 * actually cost. Both read as zero revenue, and separating them is the only
 * way "we did too much free work last quarter" becomes a sentence with a
 * cause attached.
 */
export const isOurCost = (source: CoverageSource): boolean =>
  source === "our_warranty" || source === "goodwill" || source === "no_charge_callback";
