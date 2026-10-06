import type { Permission } from "../access/permissions";

/**
 * THE SETUP WIZARD, AS DATA
 *
 * Target: a new company is taking real bookings in under an hour.
 *
 * Two decisions shape this. First, every step is skippable and the wizard
 * shows what is still missing, because a contractor who cannot find their EIN
 * at 9pm must not be blocked from booking a job tomorrow. Second, the trade
 * pack is step two rather than step nine: choosing a trade seeds a real price
 * book, and every later step is easier to answer when there is something
 * concrete on the screen instead of an empty database.
 *
 * Two steps carry a lead time and are therefore flagged: 10DLC registration
 * and Stripe onboarding both involve somebody else's review queue, and a
 * company that discovers that on cutover day has lost a week.
 *
 * Here rather than in the web app because the API publishes the same list
 * (`GET /v1/setup`) and marks steps done against these keys, and a second
 * copy of "which steps exist" is the one that would drift.
 */
export interface SetupStep {
  key: SetupStepKey;
  title: string;
  summary: string;
  /** Cannot take a booking without it. */
  essential: boolean;
  /** Involves an external review queue, so it should be started early. */
  hasLeadTime: boolean;
  /**
   * What the person needs to do this step, and therefore to mark it done.
   * A step whose permission somebody lacks is shown to them and not
   * clickable, because an office manager needs to SEE that somebody else
   * has to do payments.
   */
  permission: Permission;
}

export const SETUP_STEP_KEYS = [
  "company", "trade", "service-area", "hours", "team",
  "pricebook", "tax", "rates", "payments", "communications", "integrations",
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export const isSetupStepKey = (value: string): value is SetupStepKey =>
  (SETUP_STEP_KEYS as readonly string[]).includes(value);

export const SETUP_STEPS: readonly SetupStep[] = [
  {
    key: "company",
    title: "Company details",
    /**
     * NAMES WHAT EXISTS. The name, the legal name, the time zone, the logo
     * and the colour all have somewhere to be written now. Company licences
     * are compliance documents rather than a settings field, and are not
     * promised here.
     */
    summary: "What customers call you, your legal name, your time zone, your logo and the colour on your documents.",
    essential: true,
    hasLeadTime: false,
    permission: "settings:write",
  },
  {
    key: "trade",
    title: "Your trade",
    summary: "Loads a starting price book, job types, checklists and the KPIs that matter for your trade.",
    essential: true,
    hasLeadTime: false,
    permission: "settings:write",
  },
  {
    key: "service-area",
    title: "Service area",
    /** Drawn boundaries and drive time zones are schema and no screen. */
    summary: "The postal codes you work and what it costs to send somebody there.",
    essential: true,
    hasLeadTime: false,
    permission: "settings:write",
  },
  {
    key: "hours",
    title: "Hours and availability",
    /**
     * The holiday list is drawn here as well as under Settings, because it
     * is the other half of "when are you open". After hours and holiday
     * rates are their own step, after the price book they are chosen from.
     * The on call rota is its own screen under the schedule.
     */
    summary: "Which days you are open, the days you close for holidays, and the arrival windows you let people pick.",
    essential: true,
    hasLeadTime: false,
    permission: "booking:configure",
  },
  {
    key: "team",
    title: "Your team",
    summary: "Who works here, what each of them may do, and which branch they belong to.",
    essential: false,
    hasLeadTime: false,
    permission: "user:invite",
  },
  {
    key: "pricebook",
    title: "Price book",
    summary: "Review what the trade pack seeded and re-price it for your market.",
    essential: true,
    hasLeadTime: false,
    permission: "pricebook:write",
  },
  {
    key: "tax",
    title: "Sales tax",
    /**
     * NAMES WHAT EXISTS. The company's own rates (a name, a percentage from a
     * day, the usual one) and which price book items are taxable. No tax
     * jurisdictions: looking a rate up from an address is on the list of
     * things this project has decided not to build (BUILD.md). Marking the
     * step done needs the price book; the rates need company settings.
     */
    summary: "The sales tax rates you charge, your usual one, and which of your items are taxable.",
    essential: true,
    hasLeadTime: false,
    permission: "pricebook:write",
  },
  {
    key: "rates",
    title: "After hours and holiday rates",
    /**
     * After the price book, because both rates are items in it, marked as
     * the after hours rate a membership plan can waive. The invoice offers
     * the item for work booked outside the hours; nothing adds it by itself.
     */
    summary: "Which item you charge for work booked outside your hours, and which on a holiday. The invoice offers it; it is never added on its own.",
    essential: false,
    hasLeadTime: false,
    permission: "pricebook:write",
  },
  {
    key: "payments",
    title: "Payments",
    /** A deposit is asked for on an estimate, per estimate. */
    summary: "Connect Stripe so customers can pay a link and the office can take a card.",
    essential: true,
    hasLeadTime: true,
    permission: "integration:write",
  },
  {
    key: "communications",
    title: "Phone and email",
    summary: "Connect a carrier and a mail sender, and record your A2P 10DLC registration.",
    essential: false,
    hasLeadTime: true,
    permission: "integration:write",
  },
  {
    key: "integrations",
    title: "Accounting",
    summary: "Put every invoice and payment into QuickBooks Online or Xero.",
    essential: false,
    hasLeadTime: false,
    permission: "integration:write",
  },
];

export const stepByKey = (key: string): SetupStep | undefined =>
  SETUP_STEPS.find((step) => step.key === key);

/** One based, for "Step 4 of 10". */
export const stepNumber = (key: SetupStepKey): number =>
  SETUP_STEPS.findIndex((step) => step.key === key) + 1;

export interface SetupProgress {
  total: number;
  done: number;
  essentialTotal: number;
  essentialDone: number;
  /**
   * Where to carry on: the first outstanding step this person may do, in the
   * wizard's own order. Null when nothing is left that they can do, which is
   * a different answer from "everything is done" when somebody else holds
   * the payments step.
   */
  next: SetupStepKey | null;
  /** Every step is done. */
  complete: boolean;
}

/**
 * How far along a company is, from the steps marked done.
 *
 * The order is the wizard's order rather than essentials first. The steps
 * were put in this order because each one is easier against the one before
 * it (a trade before a price book, a price book before tax), and jumping
 * somebody ahead to the next essential would undo that.
 */
export function progress(
  completed: ReadonlySet<string>,
  may: (permission: Permission) => boolean = () => true,
): SetupProgress {
  const done = SETUP_STEPS.filter((step) => completed.has(step.key));
  const essentials = SETUP_STEPS.filter((step) => step.essential);
  const next = SETUP_STEPS.find((step) => !completed.has(step.key) && may(step.permission))?.key ?? null;
  return {
    total: SETUP_STEPS.length,
    done: done.length,
    essentialTotal: essentials.length,
    essentialDone: essentials.filter((step) => completed.has(step.key)).length,
    next,
    complete: done.length === SETUP_STEPS.length,
  };
}

/**
 * The step after this one, for "Done, next step". Wraps to nothing rather
 * than to the start: the last step's next is the list itself.
 */
export function stepAfter(key: SetupStepKey): SetupStepKey | null {
  const index = SETUP_STEP_KEYS.indexOf(key);
  return SETUP_STEP_KEYS[index + 1] ?? null;
}

export * from "./upgrade.js";
