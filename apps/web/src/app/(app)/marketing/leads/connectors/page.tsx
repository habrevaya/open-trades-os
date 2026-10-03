import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { leadConnectors, acquisition } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Crumb } from "@/components/Detail";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { LeadSourceSelect } from "@/components/LeadSourceSelect";
import { createConnector, testConnectorMapping } from "../../actions";

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
 */
export default async function LeadConnectorsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const [connectors, channels] = await Promise.all([
    leadConnectors.list(ctx),
    acquisition.channelOptions(ctx),
  ]);
  const writes = can(user.actor, "integration:write");
  const channelName = new Map(channels.map((c) => [c.id, c.name]));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/marketing/leads">Lead offers</Crumb>
      <PageHeader title="Lead sources" count={connectors.length} />

      {connectors.length === 0 ? (
        <Empty title="None set up">Set one up below and give the sender its address and secret.</Empty>
      ) : (
        <Table label="Lead sources" head={<><Th>Name</Th><Th>Credited to</Th><Th>Address to give the sender</Th><Th>Secret is kept as</Th></>}>
          {connectors.map((c) => (
            <tr key={c.id}>
              <Td>
                <span className="font-medium">{c.displayName}</span>{" "}
                {c.active ? null : <Chip tone="neutral">Off</Chip>}
              </Td>
              <Td>{c.channelId ? channelName.get(c.channelId) ?? "An archived channel" : "Not chosen"}</Td>
              <Td className="font-mono text-xs">{c.webhookPath}</Td>
              <Td className="font-mono text-xs">{c.secretEnvironmentVariable ?? c.secretRef}</Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section className="mt-10 max-w-2xl">
          <h2 className="text-base font-semibold">Set up a lead source</h2>
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
