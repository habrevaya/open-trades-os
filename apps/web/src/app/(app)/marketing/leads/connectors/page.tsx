import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { leadConnectors, leadEmails, acquisition } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Crumb } from "@/components/Detail";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { LeadSourceSelect } from "@/components/LeadSourceSelect";
import { createConnector, testConnectorMapping } from "../../actions";
import { connectMarketplace, rotateLeadInbox } from "../actions";

export const dynamic = "force-dynamic";

/**
 * SETTING UP A LEAD SOURCE, BEFORE LUNCH
 *
 * Name it, choose the channel its leads are credited to, map the sender's
 * field names onto ours, paste one of their leads in to see what it would
 * become, and hand over the address and the secret. The test is the same one
 * the API offers and writes nothing, because every sender's JSON is a
 * different shape and the alternative is learning from a dispatcher three
 * days later that every lead arrived with no phone number.
 *
 * Above that, the two ways in that need no mapping: a marketplace's own API
 * (Angi, Thumbtack, Yelp, each once the marketplace has approved the company
 * as a partner) and the lead inbox address the marketplaces' lead emails are
 * forwarded to, for every platform, approved or not.
 */
export default async function LeadConnectorsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const [connectors, channels, inbox] = await Promise.all([
    leadConnectors.list(ctx),
    acquisition.channelOptions(ctx),
    leadEmails.inbox(ctx),
  ]);
  const writes = can(user.actor, "integration:write");
  const channelName = new Map(channels.map((c) => [c.id, c.name]));
  const campaignName = new Map(channels.flatMap((c) => c.campaigns.map((k) => [k.id, `${c.name}: ${k.name}`] as const)));
  const byKind = new Map(connectors.map((c) => [c.kind, c]));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/marketing/leads">Lead offers</Crumb>
      <PageHeader title="Lead sources" count={connectors.length} />

      <section className="mt-6 max-w-3xl" aria-labelledby="inbox-heading">
        <h2 id="inbox-heading" className="text-base font-semibold">Lead inbox</h2>
        {inbox.address ? (
          <p className="mt-2 text-sm text-ink-700">
            Forward the lead emails Angi, HomeAdvisor, Thumbtack, Yelp and Nextdoor send you to{" "}
            <code className="break-all font-mono text-xs" aria-label="Lead inbox address">{inbox.address}</code>.
            Each becomes a lead offer credited to the platform that sent it.{" "}
            <a href="/marketing/leads/emails" className="underline underline-offset-4">What has arrived</a>
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-700">{inbox.missing}</p>
        )}
        {writes && inbox.address ? (
          <ActionForm action={rotateLeadInbox} submit="Give it a new address" tone="quiet" className="mt-2" />
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="marketplaces-heading">
        <h2 id="marketplaces-heading" className="text-base font-semibold">Marketplaces</h2>
        <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {inbox.platforms.map((p) => {
            const connected = byKind.get(p.key);
            return (
              <li key={p.key} className="bg-canvas p-4" aria-label={p.label}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{p.label}</span>
                  {connected ? <Chip tone="success">Connected</Chip> : null}
                  {p.api === "none" ? <Chip tone="neutral">By email only</Chip> : null}
                  {p.replies ? <Chip tone="info">Replies go back through it</Chip> : null}
                </div>
                <p className="mt-1 text-sm text-ink-700">{p.approval}</p>
                {connected ? (
                  <p className="mt-2 text-sm text-ink-700">
                    Address to give {p.label}: your public URL followed by{" "}
                    <code className="break-all font-mono text-xs">{connected.webhookPath}</code>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {writes ? (
          <div className="mt-4 max-w-2xl">
            <h3 className="text-sm font-semibold">Connect a marketplace&apos;s API</h3>
            <ActionForm action={connectMarketplace} submit="Connect it" className="mt-3 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm" htmlFor="marketplace-platform">
                  <span className="text-ink-700">Marketplace</span>
                  <select id="marketplace-platform" name="platform" className="h-9 rounded border border-steel-300 px-2 text-sm">
                    <option value="thumbtack">Thumbtack</option>
                    <option value="angi">Angi</option>
                    <option value="yelp">Yelp</option>
                  </select>
                </label>
                <TextField label="Name the office sees (optional)" name="displayName" placeholder="Thumbtack" />
              </div>
              <LeadSourceSelect options={channels} name="channel" id="marketplace-channel" label="Credit its leads to"
                                help="Leave it and the marketplace's own channel is used." />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Business id (Thumbtack and Yelp)" name="businessId" />
                <TextField label="Access token, as the name of the secret holding it (Thumbtack and Yelp)" name="apiTokenRef"
                           placeholder="THUMBTACK_TOKEN" />
              </div>
              <TextField label="Name to keep the password it posts with under (Angi and Thumbtack)" name="webhookSecretRef"
                         placeholder="THUMBTACK_WEBHOOK_PASSWORD" />
            </ActionForm>
          </div>
        ) : null}
      </section>

      <h2 className="mt-10 text-base font-semibold">Every lead source</h2>

      {connectors.length === 0 ? (
        <Empty title="None set up">Set one up below and give the sender its address and secret.</Empty>
      ) : (
        <Table label="Lead sources" head={<><Th>Name</Th><Th>How leads arrive</Th><Th>Credited to</Th><Th>Address to give the sender</Th><Th>Secret is kept as</Th></>}>
          {connectors.map((c) => (
            <tr key={c.id}>
              <Td>
                <span className="font-medium">{c.displayName}</span>{" "}
                {c.active ? null : <Chip tone="neutral">Off</Chip>}
              </Td>
              <Td>{KIND_WORDS[c.kind] ?? c.kind}</Td>
              <Td>
                {c.campaignId ? campaignName.get(c.campaignId) ?? "An archived campaign"
                  : c.channelId ? channelName.get(c.channelId) ?? "An archived channel" : "Not chosen"}
              </Td>
              <Td className="font-mono text-xs">{c.webhookPath}</Td>
              <Td className="font-mono text-xs">{c.kind === "webhook" ? c.secretEnvironmentVariable ?? c.secretRef : ""}</Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section className="mt-10 max-w-2xl">
          <h2 className="text-base font-semibold">Set up a signed webhook for anything else</h2>
          <ActionForm action={createConnector} submit="Set it up" className="mt-3 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Name the office sees" name="displayName" required placeholder="Angi" />
              <TextField label="Short name, lower case" name="source" required placeholder="angi" />
            </div>
            <LeadSourceSelect options={channels} name="channel" label="Credit its leads to"
                              help="Leave it and a known marketplace's name finds its channel; anything else lands on the marketplace channel." />
            <MapBoxes />
          </ActionForm>

          <h2 className="mt-10 text-base font-semibold">Try a lead before you go live</h2>
          <ActionForm action={testConnectorMapping} submit="See what it becomes" tone="quiet" className="mt-3 space-y-4">
            <MapBoxes />
            <TextArea label="One lead, as the sender posts it" name="sample" rows={6} required
                      placeholder='{"lead_id": "A-1", "contact": {"name": "Dana", "phone": "+15125550133"}}' />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}

/** How a lead source's leads arrive, in words. */
const KIND_WORDS: Record<string, string> = {
  webhook: "Signed webhook",
  angi: "Angi posts them",
  thumbtack: "Thumbtack posts them",
  yelp: "Yelp says, and they are read from Yelp",
  email: "Forwarded emails",
  google_lsa: "Read from Google every ten minutes",
  meta_lead_ads: "Meta posts them, and every ten minutes",
};

/**
 * One box per field this product can put a lead into, holding the sender's
 * own path to it ("contact.phone"). Blank means the usual names are tried.
 */
function MapBoxes() {
  return (
    <fieldset className="rounded-md border border-steel-200 p-3">
      <legend className="px-1 text-sm font-medium">Where each field is in what they send</legend>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {leadConnectors.TARGETS.map((t) => (
          <TextField key={t.key} label={t.label} name={`map.${t.key}`} placeholder={t.key === "contactPhone" ? "contact.phone" : ""} />
        ))}
      </div>
    </fieldset>
  );
}
