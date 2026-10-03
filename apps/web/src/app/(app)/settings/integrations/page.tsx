import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { leadIntake } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { IntegrationGroups, MARKETING_CAPABILITIES } from "./IntegrationGroups";
import { Registration } from "./Registration";
// Registers the marketing adapters, so the catalogue's built entries resolve.
import "@opentradesos/api/marketing";

export const dynamic = "force-dynamic";

/**
 * SETTINGS → INTEGRATIONS
 *
 * Every integration's setup note ended "through the API": Stripe, QuickBooks,
 * Xero, Twilio, Resend and the rest could only be connected by somebody
 * posting JSON at `/v1/connectors`, so an owner who could not do that could
 * not take a card, send a text or reach their books. This is the screen.
 *
 * It goes through the services the API already uses, so the permission and
 * the refusals are the same ones: `integration:read` to see this page,
 * `integration:write` to change anything, `agent:configure` for a model, and
 * a provider the catalogue calls named-not-built gets the reason in place of
 * a button that would connect nothing.
 *
 * Secrets are never typed here. A credential is the NAME of a secret in the
 * deployment's own store, and nothing stored is ever shown back.
 */


export default async function IntegrationsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const query = await searchParams;
  const one = (key: string) => {
    const value = query[key];
    return typeof value === "string" ? value : undefined;
  };
  /** What the return from a platform's consent screen said, in words. */
  const signedIn = one("signedIn");
  const signInError = one("signInError");
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "integration:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Integrations" />
        <Empty title="Not shown to your role">
          Seeing which outside systems this company is connected to needs the View
          connected integrations permission.
        </Empty>
      </div>
    );
  }

  const connectors = await leadIntake.catalogue(ctx);
  const writes = can(user.actor, "integration:write");
  const marketing = connectors.filter((c) => MARKETING_CAPABILITIES.has(c.capability));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Integrations" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Connect the outside systems this company runs on. Each one says what it needs, and
        what it cannot tell you, before you connect it.
        {!writes && " You can see these; changing them needs the Connect and disconnect integrations permission."}
      </p>

      {signedIn && (
        <p role="status" className="mt-4 rounded border border-steel-200 bg-steel-100 px-3 py-2 text-sm text-ink-900">
          Signed in. {connectors.find((c) => c.key === signedIn)?.label ?? "The platform"} is connected, and the first
          pull runs within a few minutes.
        </p>
      )}
      {signInError && (
        <p role="alert" className="mt-4 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{signInError}</p>
      )}

      <IntegrationGroups ctx={ctx} />
      {can(user.actor, "settings:read") ? <Registration ctx={ctx} /> : null}

      <section className="mt-8">
        <h2 className="text-base font-semibold">Lead marketplaces</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          {marketing.filter((c) => c.connected).length} of {marketing.length} lead connectors are on. Every
          marketing connector, built or not, is listed with its real state on{" "}
          <Link href="/marketing/connectors" className="underline underline-offset-4">
            Marketing → Connectors
          </Link>
          .
        </p>
        {/*
          Lead webhooks, said as what they are today. This used to say they
          were set up on the connectors page too, which has no form for them:
          an owner followed the sentence to a list with nothing to press.
          Creating one returns a signing secret exactly once and needs a field
          mapping, and until there is a screen for that it is an API call.
        */}
        <p className="mt-2 max-w-2xl text-sm text-ink-700">
          A lead webhook, for a form or lead service that posts to a URL, has no screen yet. It is
          set up through the API at <code className="text-xs">POST /v1/lead-connectors</code>, which
          returns the URL and its signing secret once.
        </p>
      </section>
    </div>
  );
}
