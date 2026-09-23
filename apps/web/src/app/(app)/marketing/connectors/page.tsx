import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { leadIntake } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { PageHeader } from "@/components/Table";
// Registers the adapters, so the catalogue's built entries resolve.
import "@opentradesos/api/marketing";

export const dynamic = "force-dynamic";

/**
 * CONNECTORS, WITH THEIR REAL STATE
 *
 * Two different facts about every row, shown as two different things,
 * because collapsing them into one checkbox could only lie about one of
 * them.
 *
 *   BUILT or NAMED says whether this product has an adapter at all.
 *   ON or OFF says whether this company set one up.
 *
 * The lie this prevents has a direction. A catalogue that showed Google Ads
 * with a connect button, when nothing imports Google spend, produces a
 * report where Google has leads and no cost. An owner reads that as a free
 * channel and moves budget onto it. Nothing in the product contradicts them
 * and the first evidence is a quarter of wasted spend.
 *
 * So a connector that is not built says so, in place of the button, with
 * what it will do and what it will need. That is more useful than a
 * "coming soon" badge and considerably more useful than hiding it, which
 * leaves an owner to conclude the product has never heard of the thing they
 * spend most of their money on.
 */
const CAPABILITY_ORDER = [
  "ads", "lead_source", "analytics", "reviews", "email",
] as const;

const CAPABILITY_LABEL: Record<string, string> = {
  ads: "Advertising",
  lead_source: "Lead sources",
  analytics: "Analytics",
  reviews: "Reviews",
  email: "Marketing email",
  messaging: "Messaging",
  telephony: "Telephony",
};

const FLOW_LABEL: Record<string, string> = {
  spend_in: "Brings in spend",
  leads_in: "Brings in leads",
  conversions_out: "Sends booked jobs back",
  analytics_in: "Brings in analytics",
  reviews_in: "Brings in reviews",
  reviews_out: "Posts replies",
  campaigns_out: "Sends campaigns",
};

export default async function ConnectorsPage() {
  const user = await requireSetupUser();
  const connectors = await leadIntake.catalogue({ actor: user.actor, db: getDb() });

  const built = connectors.filter((c) => c.state === "built").length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Connectors" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        {built} of {connectors.length} are built. The rest are named here with
        what they will do and what they will need, rather than shown as
        switches that would move no data.
      </p>

      {CAPABILITY_ORDER.map((capability) => {
        const group = connectors.filter((c) => c.capability === capability);
        if (group.length === 0) return null;

        return (
          <section key={capability} className="mt-8">
            <h2 className="text-base font-semibold">
              {CAPABILITY_LABEL[capability] ?? capability}
            </h2>
            <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
              {group.map((connector) => (
                <li key={connector.key} className="bg-canvas p-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{connector.label}</span>
                    {connector.state === "built"
                      ? <Chip tone="success">Built</Chip>
                      /*
                        "Named" rather than "Coming soon". Coming soon is a
                        promise about a date nobody has made.
                      */
                      : <Chip tone="neutral">Named, not built</Chip>}
                    {connector.connected && <Chip tone="info">On</Chip>}
                    {connector.lastError && <Chip tone="danger">Erroring</Chip>}
                  </div>

                  <p className="mt-1 text-sm text-ink-700">{connector.purpose}</p>

                  <p className="mt-2 text-sm text-ink-500">
                    <span className="font-medium text-ink-700">Needs: </span>
                    {connector.setup}
                  </p>
                  <p className="mt-1 text-sm text-ink-500">
                    {/*
                      Shown, never tucked behind a tooltip. Every one of
                      these is wrong about something, and a catalogue that
                      only lists what a connector does is a sales page.
                    */}
                    <span className="font-medium text-ink-700">Will not tell you: </span>
                    {connector.limitation}
                  </p>

                  <p className="mt-2 flex flex-wrap gap-2 text-xs text-ink-500">
                    {connector.flows.map((flow) => (
                      <span key={flow} className="rounded border border-steel-200 px-2 py-0.5">
                        {FLOW_LABEL[flow] ?? flow}
                      </span>
                    ))}
                  </p>

                  {connector.lastError && (
                    <p className="mt-2 text-sm text-red-600">{connector.lastError}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
