import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { leadIntake, payments } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ConnectForm } from "./ConnectForm";
import { FORMS } from "./fields";
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
const GROUPS: { capability: string; title: string; description: string }[] = [
  { capability: "payments", title: "Card payments",
    description: "Take a card on the invoice link and in the field. The webhook is what marks an invoice paid." },
  { capability: "accounting", title: "Accounting",
    description: "Invoices, payments and write-offs into the books your accountant uses. Map your accounts after connecting." },
  { capability: "messaging", title: "Texting",
    description: "Reminders, arrival notices and the shared inbox. Replies route back on the webhook address shown once connected." },
  { capability: "email", title: "Email",
    description: "Invoices, estimates and notices by email." },
  { capability: "telephony", title: "Call tracking",
    description: "Which marketing made the phone ring." },
  { capability: "ai_model", title: "AI models",
    description: "Your own key, your own bill, the same permissions as the person asking." },
  { capability: "calendar", title: "Calendar",
    description: "A technician's visits in the calendar they already use." },
  { capability: "maps", title: "Maps and addresses",
    description: "Puts customers' addresses on the dispatch map in the background, so the route optimiser has something to measure. A pin placed by hand on a property always wins." },
];

const MARKETING = new Set(["ads", "lead_source", "analytics", "reviews"]);

export default async function IntegrationsPage() {
  const user = await requireSetupUser();
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

  const [connectors, card] = await Promise.all([
    leadIntake.catalogue(ctx),
    payments.status(ctx),
  ]);
  const writes = can(user.actor, "integration:write");
  const configuresAi = can(user.actor, "agent:configure");
  const marketing = connectors.filter((c) => MARKETING.has(c.capability));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Integrations" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Connect the outside systems this company runs on. Each one says what it needs, and
        what it cannot tell you, before you connect it.
        {!writes && " You can see these; changing them needs the Connect and disconnect integrations permission."}
      </p>

      {GROUPS.map((group) => {
        const rows = connectors.filter((c) => c.capability === group.capability);
        if (rows.length === 0) return null;
        return (
          <section key={group.capability} className="mt-8">
            <h2 className="text-base font-semibold">{group.title}</h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-700">{group.description}</p>
            <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
              {rows.map((c) => {
                const form = FORMS[c.key];
                const mayChange = form?.via === "ai" ? configuresAi : writes;
                return (
                  <li key={c.key} className="bg-canvas p-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{c.label}</span>
                      {c.state !== "built"
                        ? <Chip tone="neutral">Named, not built</Chip>
                        : c.connected
                          ? <Chip tone="success">Connected</Chip>
                          : c.connectionStatus
                            ? <Chip tone="neutral">{c.connectionStatus === "disconnected" ? "Off" : c.connectionStatus}</Chip>
                            : null}
                      {c.lastError && <Chip tone="danger">Erroring</Chip>}
                    </div>
                    <p className="mt-1 text-sm text-ink-700">{c.purpose}</p>
                    <p className="mt-2 text-sm text-ink-500">
                      <span className="font-medium text-ink-700">Needs: </span>{c.setup}
                    </p>
                    <p className="mt-1 text-sm text-ink-500">
                      <span className="font-medium text-ink-700">Will not tell you: </span>{c.limitation}
                    </p>

                    {c.connected && c.credentialRef && (
                      <p className="mt-2 text-sm text-ink-700">
                        Secret name: <code className="font-mono text-xs">{c.credentialRef}</code>
                      </p>
                    )}
                    {c.key === "stripe" && c.connected && !card.webhookConfigured && (
                      /*
                        The failure that looks like success: cards are taken
                        and no invoice ever closes.
                      */
                      <p className="mt-2 rounded bg-red-tint px-3 py-2 text-sm text-red-600">
                        No webhook signing secret is set. Cards will be taken and no payment will
                        be recorded until it is.
                      </p>
                    )}
                    {c.webhookPath && (
                      <p className="mt-2 text-sm text-ink-700">
                        Webhook address: your public URL followed by{" "}
                        <code className="break-all font-mono text-xs">{c.webhookPath}</code>
                      </p>
                    )}
                    {c.notice && (
                      <p className="mt-2 rounded bg-red-tint px-3 py-2 text-sm text-red-600" role="alert">
                        {c.notice}
                      </p>
                    )}
                    {c.lastError && <p className="mt-2 text-sm text-red-600">{c.lastError}</p>}

                    {c.state === "built" && form?.noForm && (
                      <p className="mt-2 text-sm text-ink-500">{form.noForm}</p>
                    )}
                    {c.state === "built" && form && !form.noForm && mayChange && (
                      <ConnectForm
                        provider={c.key}
                        label={c.label}
                        form={form}
                        connected={c.connected}
                        credentialRef={c.credentialRef}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <section className="mt-8">
        <h2 className="text-base font-semibold">Marketing</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          {marketing.filter((c) => c.connected).length} of {marketing.length} advertising, lead,
          analytics and review connectors are on. They are listed with their real state on{" "}
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
