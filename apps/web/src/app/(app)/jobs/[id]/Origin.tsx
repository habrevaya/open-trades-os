import { marketing as mk } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { LeadSourceSelect, type SourceOption } from "@/components/LeadSourceSelect";
import { formatIn } from "@/lib/dates";
import { setJobSource } from "./actions";

type Attribution = {
  companyModel: string;
  touches: {
    id: string; occurredAt: Date; sourceLabel: string; basis: string; enteredByPerson: boolean;
    channelName: string | null; campaignName: string | null; trackedNumberE164: string | null;
  }[];
  agree: boolean;
  models: {
    model: string; label: string; wrongAbout: string; attributed: boolean;
    credits?: { source: string; percent: string }[]; detail?: string; note?: string | null;
  }[];
};

/** How a touch was known, in the words of somebody reading the job. */
const BASIS: Record<string, string> = {
  utm: "a tagged link",
  click_id: "an ad click",
  tracked_number: "a call to a tracking number",
  referrer: "the site they came from",
  declared: "declared",
  none: "nothing recorded with the visit",
};

const ORIGIN: Record<string, string> = {
  manual: "chosen by the office",
  derived: "worked out from what they did",
  imported: "from the system it was moved from",
};

/**
 * WHERE THIS JOB CAME FROM
 *
 * The job's own answer first (the source on the job, and whether somebody
 * chose it or the touches implied it), then the evidence: every touch
 * credited to the job, oldest first, and what each attribution model makes of
 * them. The disagreement between models is shown, not resolved, because when
 * first touch and last touch name different channels somebody is about to cut
 * the one that starts every job.
 *
 * The evidence needs the marketing permission; the answer and the correction
 * do not, because the CSR who booked the job is the person most likely to know
 * the customer said "the van" rather than "Google".
 */
export function Origin({
  jobId, job, sources, attribution, writes, timezone,
}: {
  jobId: string;
  job: {
    leadSource: string | null; leadSourceOrigin?: string | null | undefined;
    channelId?: string | null | undefined; acquisitionCampaignId?: string | null | undefined;
  };
  sources: SourceOption[];
  attribution: Attribution | null;
  writes: boolean;
  timezone: string;
}) {
  const channel = sources.find((c) => c.id === job.channelId);
  const campaign = channel?.campaigns.find((k) => k.id === job.acquisitionCampaignId);
  return (
    <section aria-label="Where this job came from">
      <h2 className="mt-10 text-base font-semibold">Where this job came from</h2>
      <p className="mt-2 text-sm text-ink-700">
        {job.leadSource ? (
          <>
            <span className="font-medium text-ink-900">
              {[channel?.name ?? mk.leadSourceLabel(job.leadSource), campaign?.name].filter(Boolean).join(", ")}
            </span>
            {job.leadSourceOrigin ? <span className="text-ink-500"> ({ORIGIN[job.leadSourceOrigin] ?? job.leadSourceOrigin})</span> : null}
          </>
        ) : (
          <span className="text-ink-500">
            Nothing recorded. Not counted as direct, because it is not: ask the customer and choose one.
          </span>
        )}
      </p>

      {writes ? (
        <ActionForm action={setJobSource} submit="Save where it came from" tone="quiet"
                    hidden={{ jobId }} className="mt-3 flex max-w-xl flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <LeadSourceSelect options={sources} label="Change it" name="source"
                              defaultValue={job.acquisitionCampaignId ? `campaign:${job.acquisitionCampaignId}` : job.channelId ? `channel:${job.channelId}` : ""} />
          </div>
        </ActionForm>
      ) : null}

      {attribution ? (
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium">What they did</h3>
            {attribution.touches.length === 0 ? (
              <p className="mt-1 text-sm text-ink-500">No touches were credited to this job.</p>
            ) : (
              <ol className="mt-1 space-y-1.5 text-sm">
                {attribution.touches.map((t) => (
                  <li key={t.id}>
                    <span className="tabular-nums text-ink-500">
                      {formatIn(new Date(t.occurredAt), timezone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>{" "}
                    <span className="font-medium">{[t.channelName ?? t.sourceLabel, t.campaignName].filter(Boolean).join(", ")}</span>{" "}
                    <span className="text-ink-500">
                      from {t.basis === "declared" ? (t.enteredByPerson ? "the office's choice" : "the sender's own word") : BASIS[t.basis] ?? t.basis}
                      {t.trackedNumberE164 ? ` (${t.trackedNumberE164})` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <h3 className="text-sm font-medium">
              Who gets the credit{" "}
              {attribution.agree ? <Chip tone="success">Every model agrees</Chip> : <Chip tone="warning">The models disagree</Chip>}
            </h3>
            <ul className="mt-1 space-y-2 text-sm">
              {attribution.models.map((m) => (
                <li key={m.model}>
                  <span className="font-medium">{m.label}</span>
                  {m.model === attribution.companyModel ? <span className="text-ink-500"> (your company&rsquo;s)</span> : null}
                  {": "}
                  {m.attributed && m.credits
                    ? m.credits.map((c) => `${mk.leadSourceLabel(c.source)} ${c.percent}%`).join(", ")
                    : <span className="text-ink-500">not attributed</span>}
                  <span className="block text-xs text-ink-500">{m.wrongAbout}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
