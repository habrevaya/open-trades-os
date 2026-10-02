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
  /**
   * WHERE THIS IS ACTUALLY CONFIGURED, OR NOTHING.
   *
   * The wizard used to link every step at `/setup/<key>`, and one of those ten
   * pages existed. Nine steps were a 404 from the product's own onboarding,
   * which is worse than a missing feature: it reads as broken rather than
   * unfinished. The link test could not see it either, because the href was
   * written as a conditional template literal and the test anchored on two
   * shapes it was not one of.
   *
   * So a step says where it goes, and most of them go to the screen where that
   * setting really lives rather than to a wizard page duplicating it. Required
   * rather than optional: a step nobody can get to is not a step, and making
   * this field optional is how the next one would arrive without a destination.
   * A step whose setting has no screen gets its summary narrowed to what does,
   * which is what happened to four of these.
   */
  href: string;
}

export const SETUP_STEPS: SetupStep[] = [
  {
    key: "company",
    title: "Company details",
    /**
     * NAMES WHAT EXISTS. This said "legal name, what customers call you, your
     * logo and licence numbers" and two of those four have a screen: the name
     * and the logo. A legal name and an EIN are columns nothing writes, and
     * company licences are compliance documents rather than a settings field.
     */
    summary: "What customers call you, your logo and the colour on your documents.",
    essential: true,
    permission: "settings:write",
    href: "/settings",
  },
  {
    key: "trade",
    title: "Your trade",
    summary: "Loads a starting price book, job types, checklists and the KPIs that matter for your trade.",
    essential: true,
    permission: "settings:write",
    href: "/setup/trade",
  },
  {
    key: "service-area",
    title: "Service area",
    /** Drawn boundaries and drive time zones are schema and no screen. */
    summary: "The postal codes you work and what it costs to send somebody there.",
    essential: true,
    permission: "settings:write",
    href: "/settings/service-area",
  },
  {
    key: "hours",
    title: "Hours and availability",
    /**
     * Which days you are open and the arrival windows you offer are on the
     * booking screen, because that is what consumes them. The on call rota is
     * its own screen under the schedule. Holidays and after hours rates are
     * neither, and are no longer promised here.
     */
    summary: "Which days you are open and the arrival windows you let people pick.",
    essential: true,
    permission: "booking:configure",
    href: "/booking",
  },
  {
    key: "team",
    title: "Your team",
    summary: "Who works here and what each of them may do.",
    essential: false,
    permission: "user:invite",
    href: "/settings",
  },
  {
    key: "pricebook",
    title: "Price book",
    summary: "Review what the trade pack seeded and re-price it for your market.",
    essential: true,
    permission: "pricebook:write",
    href: "/pricebook",
  },
  {
    key: "tax",
    title: "Sales tax",
    /**
     * NAMES WHAT EXISTS, and this one is the furthest from what it claimed.
     * There are no tax jurisdictions and no rate table: a rate is carried on
     * the line it was charged on, and taxability is a property of a price book
     * item. Determining a rate is on the list of things this project has
     * decided not to build (BUILD.md), so a setup step offering jurisdictions
     * was offering a screen nobody will ever write.
     */
    summary: "Which of your items are taxable and under which class. Rates are set on the document.",
    essential: true,
    permission: "pricebook:write",
    href: "/pricebook",
  },
  {
    key: "payments",
    title: "Payments",
    /** Tipping is not built. A deposit is asked for on an estimate, per estimate. */
    summary: "Connect Stripe so customers can pay a link and the office can take a card.",
    essential: true,
    hasLeadTime: true,
    permission: "integration:write",
    href: "/settings/integrations",
  },
  {
    key: "communications",
    title: "Phone and email",
    summary: "Connect a carrier and a mail sender, register for A2P 10DLC, verify your domain.",
    essential: false,
    hasLeadTime: true,
    permission: "integration:write",
    href: "/settings/integrations",
  },
  {
    key: "integrations",
    /**
     * NAMES WHAT EXISTS. This said "QuickBooks or Xero, and Google or Outlook
     * calendar" while there was no accounting adapter at all and no calendar
     * capability of any kind. QuickBooks is now built; the other three are
     * not, and a setup step offering them is a person spending an afternoon
     * looking for a screen that was never written.
     */
    title: "Accounting",
    summary: "Put every invoice and payment into QuickBooks Online or Xero.",
    essential: false,
    permission: "integration:write",
    href: "/settings/integrations",
  },
];

export const essentialSteps = SETUP_STEPS.filter((s) => s.essential);
