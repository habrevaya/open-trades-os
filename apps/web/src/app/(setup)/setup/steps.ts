import { setup } from "@opentradesos/core";

/**
 * THE SETUP WIZARD'S STEPS, AND WHERE EACH ONE LIVES
 *
 * The steps themselves (their order, which are essential, what each needs)
 * are `SETUP_STEPS` in core, because the API publishes the same list and
 * marks steps done against those keys.
 *
 * What this adds is where they are on screen, twice. `href` is the wizard's
 * own page for the step, which draws the real settings form rather than a
 * copy of it. `later` is where the same setting lives once setup is over, so
 * every step page can say where to change it next year. The wizard used to
 * link most steps to settings screens and one to a page of its own, and nine
 * of the ten links were once a 404; every step having a page of its own is
 * what a person following the list expects, and `routes.test.ts` checks both
 * links resolve.
 */
export interface SetupStepLink extends setup.SetupStep {
  href: string;
  later: { href: string; label: string };
}

/**
 * Written out per step rather than built from the key, so `routes.test.ts`
 * checks each address against a real page: a template would hide a step
 * with no page behind it, which is exactly how nine dead links once shipped.
 */
const PAGE: Record<setup.SetupStepKey, string> = {
  company: "/setup/company",
  trade: "/setup/trade",
  "service-area": "/setup/service-area",
  hours: "/setup/hours",
  team: "/setup/team",
  pricebook: "/setup/pricebook",
  tax: "/setup/tax",
  payments: "/setup/payments",
  communications: "/setup/communications",
  integrations: "/setup/integrations",
};

const LATER: Record<setup.SetupStepKey, { href: string; label: string }> = {
  company: { href: "/settings", label: "Settings" },
  trade: { href: "/setup/trade", label: "this page, from Settings" },
  "service-area": { href: "/settings/service-area", label: "Settings, Service area" },
  hours: { href: "/booking", label: "Online booking" },
  team: { href: "/settings/team", label: "Settings, Team" },
  pricebook: { href: "/pricebook", label: "Price book" },
  tax: { href: "/pricebook/tax", label: "Price book, Sales tax" },
  payments: { href: "/settings/integrations", label: "Settings, Integrations" },
  communications: { href: "/settings/integrations", label: "Settings, Integrations" },
  integrations: { href: "/settings/integrations", label: "Settings, Integrations" },
};

export const SETUP_STEPS: SetupStepLink[] = setup.SETUP_STEPS.map((step) => ({
  ...step,
  href: PAGE[step.key],
  later: LATER[step.key],
}));

export const essentialSteps = SETUP_STEPS.filter((s) => s.essential);

export const stepLink = (key: setup.SetupStepKey): SetupStepLink => SETUP_STEPS.find((s) => s.key === key)!;
