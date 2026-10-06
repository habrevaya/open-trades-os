import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { acquisition, NotFoundError } from "@opentradesos/api/services";
import { can, marketing as mk } from "@opentradesos/core";
import { Chip, Money, Phone } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td, Empty } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { todayIn } from "@/lib/dates";
import { updateTrackingCampaign } from "../../actions";
import { CampaignFields } from "../CampaignFields";

export const dynamic = "force-dynamic";

/**
 * ONE TRACKING CAMPAIGN: its numbers, what it has cost, and the way to its
 * figures on the funnel.
 *
 * Each number with its calls in the last ninety days, because a number still
 * being paid for that nobody rings is visible here, where somebody decides
 * whether to keep paying for it.
 */
export default async function TrackingCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { id } = await params;
  const campaign = await acquisition.getCampaign(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const channels = await acquisition.listChannels(ctx);
  const writes = can(user.actor, "adspend:write");
  const today = todayIn(user.organizationTimezone);
  const funnel = `/marketing?${new URLSearchParams({
    by: "campaign", from: campaign.startsOn ?? today, to: campaign.endsOn && campaign.endsOn < today ? campaign.endsOn : today,
  }).toString()}`;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/marketing/tracking">Tracking campaigns</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">{campaign.name}</h1>
        {campaign.archived ? <Chip tone="neutral">Archived</Chip> : <Chip tone="success">Running</Chip>}
      </div>

      <Facts>
        <Fact label="Channel">{campaign.channelName}</Fact>
        <Fact label="Dates">{[campaign.startsOn, campaign.endsOn].filter(Boolean).join(" to ") || "Open"}</Fact>
        <Fact label="Cost">
          {mk.COST_MODELS[campaign.costModel as mk.CostModel]?.label}
          {campaign.costAmount ? <> <Money value={campaign.costAmount} /></> : null}
        </Fact>
        <Fact label="Recorded spend"><Money value={campaign.recordedSpend} /></Fact>
        <Fact label="Budget">{campaign.budget ? <Money value={campaign.budget} /> : null}</Fact>
        <Fact label="Link tag">{campaign.utmCampaign}</Fact>
      </Facts>
      <p className="mt-3 text-sm">
        <a href={funnel} className="underline underline-offset-4">Its calls, leads, jobs and return on the funnel</a>
      </p>

      <h2 className="mt-8 text-base font-semibold">Tracking numbers</h2>
      {campaign.numbers.length === 0 ? (
        <Empty title="No number on this campaign">
          Add a tracking number under <a href="/settings" className="underline underline-offset-4">Settings</a> and
          credit its calls to this campaign.
        </Empty>
      ) : (
        <Table label="Tracking numbers" head={<><Th>Number</Th><Th>Label</Th><Th>Calls in 90 days</Th></>}>
          {campaign.numbers.map((n) => (
            <tr key={n.id}>
              <Td><Phone value={n.e164} /></Td>
              <Td className="text-ink-700">{n.label ?? ""}</Td>
              <Td>
                <a href={`/marketing/calls?number=${n.id}`} className="tabular-nums underline underline-offset-4">{n.calls}</a>
                {n.calls === 0 ? <> <Chip tone="warning">Nobody has rung it</Chip></> : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Change it</h2>
          <ActionForm action={updateTrackingCampaign} submit="Save campaign" hidden={{ id }} className="mt-3 space-y-4">
            <CampaignFields channels={channels} current={campaign} />
          </ActionForm>
          <ActionForm action={updateTrackingCampaign} submit={campaign.archived ? "Bring it back" : "Archive it"}
                      tone="quiet" hidden={{ id, archive: campaign.archived ? "no" : "yes" }} />
        </section>
      ) : null}
    </div>
  );
}
