import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { acquisition } from "@opentradesos/api/services";
import { can, marketing as mk } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { createChannel, updateChannel, saveSettings } from "../actions";

export const dynamic = "force-dynamic";

/**
 * WHERE WORK COMES FROM, IN THE COMPANY'S OWN WORDS
 *
 * The list starts as the lead source catalogue, one channel per key, and
 * becomes the company's: add Angi and Thumbtack as two channels under the
 * marketplace key, call the van "The trucks", archive the radio station you
 * stopped buying. Every channel names the catalogue key it is a kind of, so a
 * company's twelve names still roll up to the twenty one every report knows.
 *
 * This is also where the company picks its attribution model and says whether
 * every new customer and job must carry a source, because both are decisions
 * about the same list.
 */
export default async function ChannelsPage(
  { searchParams }: { searchParams: Promise<{ archived?: string }> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { archived } = await searchParams;
  const [channels, settings] = await Promise.all([
    acquisition.listChannels(ctx, { includeArchived: archived === "show" }),
    acquisition.getSettings(ctx),
  ]);
  const writes = can(user.actor, "adspend:write");
  const sources = mk.LEAD_SOURCES.filter((s) => s.key !== "unknown")
    .map((s) => ({ value: s.key, label: s.label }));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Channels" count={channels.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The list a CSR picks from on a new customer or job, and the rows of the funnel. Rename them
        to what your office says; archive the ones you no longer buy, and their history stays.
      </p>
      <p className="mt-1 text-sm">
        <a href={archived === "show" ? "/marketing/channels" : "/marketing/channels?archived=show"}
           className="underline underline-offset-4">
          {archived === "show" ? "Hide archived channels" : "Show archived channels"}
        </a>
      </p>

      <Table label="Channels" head={<><Th>Channel</Th><Th>Counts as</Th><Th>{writes ? "Change" : ""}</Th></>}>
        {channels.map((channel) => (
          <tr key={channel.id}>
            <Td>
              <span className="font-medium">{channel.name}</span>{" "}
              {channel.archived ? <Chip tone="neutral">Archived</Chip> : null}
            </Td>
            <Td className="text-ink-700">{channel.sourceLabel}</Td>
            <Td>
              {writes ? (
                <div className="flex flex-wrap items-end gap-2">
                  <ActionForm action={updateChannel} submit="Rename" tone="quiet" hidden={{ id: channel.id }}
                              className="flex flex-wrap items-end gap-2">
                    <input name="name" defaultValue={channel.name} aria-label={`New name for ${channel.name}`}
                           className="h-9 w-44 rounded border border-steel-300 px-2 text-sm" />
                  </ActionForm>
                  <ActionForm action={updateChannel} submit={channel.archived ? "Bring back" : "Archive"} tone="quiet"
                              hidden={{ id: channel.id, archive: channel.archived ? "no" : "yes" }}
                              className="flex items-end gap-2" />
                </div>
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>

      {writes ? (
        <section className="mt-10 max-w-xl">
          <h2 className="text-base font-semibold">Add a channel</h2>
          <ActionForm action={createChannel} submit="Add channel" className="mt-3 space-y-3">
            <TextField label="Name" name="name" required placeholder="Angi" maxLength={80} />
            <Select label="It is a kind of" name="sourceKey" options={sources} defaultValue="marketplace" />
          </ActionForm>
        </section>
      ) : null}

      {can(user.actor, "settings:write") ? (
        <section className="mt-10 max-w-xl">
          <h2 className="text-base font-semibold">How credit is given</h2>
          <ActionForm action={saveSettings} submit="Save" className="mt-3 space-y-3">
            <Select label="Attribution model" name="attributionModel" defaultValue={settings.attributionModel}
                    options={mk.ATTRIBUTION_MODEL_KEYS.map((key) => ({ value: key, label: mk.ATTRIBUTION_MODELS[key].label }))} />
            <p className="text-xs text-ink-500">
              The model fills in a job&rsquo;s source when nobody chose one, and is the one the funnel
              opens with. Each is wrong about something, and the funnel says what beside its figures.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="requireLeadSource" value="yes" defaultChecked={settings.requireLeadSource} />
              Every new customer and job must say where it came from
            </label>
            <p className="text-xs text-ink-500">
              Only asked when nothing was recorded: a customer who rang a tracking number already has
              an answer. Turn it on once the office knows the list, or &ldquo;Direct&rdquo; gets chosen to
              get past the form.
            </p>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
