/**
 * THE SETUP WIZARD
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
 */
export interface SetupStep {
  key: string;
  title: string;
  summary: string;
  /** Cannot take a booking without it. */
  essential: boolean;
  /** Involves an external review queue, so it should be started early. */
  hasLeadTime?: boolean;
  permission: string;
}

export const SETUP_STEPS: SetupStep[] = [
  {
    key: "company",
    title: "Company details",
    summary: "Legal name, what customers call you, your logo and licence numbers.",
    essential: true,
    permission: "settings:write",
  },
  {
    key: "trade",
    title: "Your trade",
    summary: "Loads a starting price book, job types, checklists and the KPIs that matter for your trade.",
    essential: true,
    permission: "settings:write",
  },
  {
    key: "service-area",
    title: "Service area",
    summary: "Postal codes or drawn territories, drive time zones and travel fees.",
    essential: true,
    permission: "settings:write",
  },
  {
    key: "hours",
    title: "Hours and availability",
    summary: "Business hours, holidays, on call rotation and after hours rates.",
    essential: true,
    permission: "settings:write",
  },
  {
    key: "team",
    title: "Your team",
    summary: "Invite office staff and technicians, set roles and pay rates.",
    essential: false,
    permission: "user:invite",
  },
  {
    key: "pricebook",
    title: "Price book",
    summary: "Review what the trade pack seeded and set your margin target.",
    essential: true,
    permission: "pricebook:write",
  },
  {
    key: "tax",
    title: "Sales tax",
    summary: "Jurisdictions, rates, and which item classes are taxable.",
    essential: true,
    permission: "settings:write",
  },
  {
    key: "payments",
    title: "Payments",
    summary: "Connect Stripe, set your deposit policy and tipping.",
    essential: true,
    hasLeadTime: true,
    permission: "integration:write",
  },
  {
    key: "communications",
    title: "Phone and email",
    summary: "Provision a number, register for A2P 10DLC, verify your sending domain.",
    essential: false,
    hasLeadTime: true,
    permission: "integration:write",
  },
  {
    key: "integrations",
    title: "Accounting and calendar",
    summary: "QuickBooks or Xero, and Google or Outlook calendar.",
    essential: false,
    permission: "integration:write",
  },
];

export const essentialSteps = SETUP_STEPS.filter((s) => s.essential);
