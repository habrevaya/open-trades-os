import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { acquisition } from "@opentradesos/api/services";
import { can, marketing as mk } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { createTrackingCampaign } from "../actions";
import { CampaignFields } from "./CampaignFields";

export const dynamic = "force-dynamic";

/**
 * TRACKING CAMPAIGNS: WHAT A NUMBER AND A BUDGET BELONG TO
 *
 * "Spring AC tune up" under Google Ads, with its dates, what it costs and the
 * tag its links carry. A tracking number is put on one, and every call to
 * that number, every click carrying the tag, every spend row against it and
 * every job those turn into are credited to it on the funnel.
 *
 * Not the texts and emails sent to your own list, which have their own screen
 * and their own word for themselves, and not the carrier registration a
 * texting number sends under.
 */
export default async function TrackingCampaignsPage(
  { searchParams }: { searchParams: Promise<{ archived?: string }> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { archived } = await searchParams;
  const [campaigns, channels] = await Promise.all([
    acquisition.listCampaigns(ctx, { includeArchived: archived === "show" }),
    acquisition.listChannels(ctx),
  ]);
  const writes = can(user.actor, "adspend:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Tracking campaigns" count={campaigns.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Put a tracking number on a campaign and every call to it is credited there. Give the campaign
        the tag its links carry and every click is too.
      </p>
      <p className="mt-1 text-sm">
        <a href={archived === "show" ? "/marketing/tracking" : "/marketing/tracking?archived=show"}
           className="underline underline-offset-4">
          {archived === "show" ? "Hide archived campaigns" : "Show archived campaigns"}
        </a>
      </p>

      {campaigns.length === 0 ? (
        <Empty title="No tracking campaigns yet">
          Start one below, then put a tracking number on it under Settings.
        </Empty>
      ) : (
        <Table label="Tracking campaigns"
               head={<><Th>Campaign</Th><Th>Channel</Th><Th>Dates</Th><Th>Cost</Th><Th>Numbers</Th></>}>
          {campaigns.map((c) => (
            <tr key={c.id}>
              <Td>
                <a href={`/marketing/tracking/${c.id}`} className="font-medium underline underline-offset-4">{c.name}</a>{" "}
                {c.archived ? <Chip tone="neutral">Archived</Chip> : null}
              </Td>
              <Td className="text-ink-700">{c.channelName}</Td>
              <Td className="text-ink-700">{[c.startsOn, c.endsOn].filter(Boolean).join(" to ") || "Open"}</Td>
              <Td className="text-ink-700">
                {mk.COST_MODELS[c.costModel as mk.CostModel]?.label ?? c.costModel}
                {c.costAmount ? <> <Money value={c.costAmount} /></> : null}
              </Td>
              <Td className="tabular-nums">{c.numbers}</Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section className="mt-10 max-w-2xl">
          <h2 className="text-base font-semibold">Start a tracking campaign</h2>
          <ActionForm action={createTrackingCampaign} submit="Start campaign" className="mt-3 space-y-4">
            <CampaignFields channels={channels} />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
