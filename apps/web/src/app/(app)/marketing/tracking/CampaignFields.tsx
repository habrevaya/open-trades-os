import { marketing as mk } from "@opentradesos/core";
import { Select, TextArea, TextField } from "@/components/ActionForm";

/**
 * The boxes a tracking campaign is made of, shared by "start one" and
 * "change it" so the two cannot ask different questions.
 *
 * The cost model is a choice with its meaning beside it, because "fixed",
 * "recorded" and "per lead" are three different arithmetics and an owner
 * picking one is deciding what the cost per lead on the funnel will mean.
 */
export function CampaignFields({
  channels, current,
}: {
  channels: { id: string; name: string }[];
  current?: {
    channelId: string; name: string; startsOn: string | null; endsOn: string | null;
    costModel: string; costAmount: string | null; budget: string | null;
    utmCampaign: string | null; notes: string | null;
  };
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" name="name" required maxLength={120} placeholder="Spring AC tune up"
                   defaultValue={current?.name} />
        <Select label="Channel" name="channelId" defaultValue={current?.channelId}
                options={channels.map((c) => ({ value: c.id, label: c.name }))} />
        <TextField label="Starts" name="startsOn" type="date" defaultValue={current?.startsOn ?? undefined} />
        <TextField label="Ends" name="endsOn" type="date" defaultValue={current?.endsOn ?? undefined} />
      </div>
      <fieldset className="rounded-md border border-steel-200 p-3">
        <legend className="px-1 text-sm font-medium">What it costs</legend>
        <div className="space-y-2 text-sm">
          {(Object.keys(mk.COST_MODELS) as mk.CostModel[]).map((key) => (
            <label key={key} className="flex items-start gap-2">
              <input type="radio" name="costModel" value={key}
                     defaultChecked={(current?.costModel ?? "recorded") === key} className="mt-1" />
              <span>
                <span className="font-medium">{mk.COST_MODELS[key].label}</span>
                <span className="block text-xs text-ink-500">{mk.COST_MODELS[key].meaning}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <TextField label="The price (fixed, or of one lead)" name="costAmount" inputMode="decimal"
                     defaultValue={current?.costAmount ?? undefined} />
          <TextField label="Budget (a plan, never added to the cost)" name="budget" inputMode="decimal"
                     defaultValue={current?.budget ?? undefined} />
        </div>
      </fieldset>
      <TextField label="Link tag (utm_campaign)" name="utmCampaign" maxLength={100}
                 placeholder="spring_ac" defaultValue={current?.utmCampaign ?? undefined} />
      <TextArea label="Notes" name="notes" maxLength={2000} defaultValue={current?.notes ?? undefined} />
    </>
  );
}
