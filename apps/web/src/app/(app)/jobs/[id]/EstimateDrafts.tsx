import { agents, agentEstimates, type ServiceContext } from "@opentradesos/api/services";
import { can, type agents as coreAgents } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { draftOptions, makeEstimate, setOptionsAside } from "./estimate-draft-actions";

/**
 * ESTIMATE OPTIONS FROM THE DRAFTER
 *
 * On the job, because the job is what it reads: the notes, the photo
 * captions, the readings and the equipment. Every line is a price book item at
 * the price book's price, said beside the options so nobody has to wonder
 * whether a number was invented. "Make the estimate" writes a draft estimate
 * for a person to edit and send from its own screen.
 */
export async function EstimateDrafts({ ctx, jobId }: { ctx: ServiceContext; jobId: string }) {
  if (!can(ctx.actor, "estimate:read")) return null;
  const [on, listed] = await Promise.all([
    agents.isOn(ctx, "estimate"),
    agentEstimates.handlers.listEstimateDrafts(ctx, { jobId, limit: 5 }),
  ]);
  const latest = listed.drafts.find((d) => d.status === "proposed" || d.status === "applied" || d.action === "cannot_estimate");
  const writes = can(ctx.actor, "estimate:write");
  if (!on && !latest) return null;

  const options = (latest?.draft["options"] ?? []) as coreAgents.PricedOption[];
  const outcome = latest?.outcome as { estimateId?: string } | null | undefined;

  return (
    <section aria-label="Estimate options from the drafter" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">Estimate options</h2>
        {on && writes ? (
          <ActionForm action={draftOptions} submit={latest ? "Draft them again" : "Draft options from the notes"}
                      hidden={{ jobId }} tone="quiet" className="flex items-center" />
        ) : null}
      </div>
      {!latest ? (
        <p className="mt-2 text-sm text-ink-500">
          The drafter reads this job&apos;s notes, photo captions and readings and suggests options from your price book.
        </p>
      ) : latest.action === "cannot_estimate" ? (
        <p className="mt-2 text-sm text-amber-700">{latest.note ?? "The notes do not say enough to price the work."}</p>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-ink-700">{String(latest.draft["summary"] ?? "")}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {options.map((option) => (
              <div key={option.name} className="rounded-md border border-steel-200 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-medium">{option.name}</h3>
                  {option.recommended ? <Chip tone="info">Recommended</Chip> : null}
                </div>
                {option.description ? <p className="mt-1 text-sm text-ink-700">{option.description}</p> : null}
                <ul className="mt-2 space-y-1 text-sm">
                  {option.lines.map((line, i) => (
                    <li key={`${line.priceBookItemId}-${i}`}>
                      <span>{Number(line.quantity) === 1 ? "" : `${Number(line.quantity)} × `}{line.name}</span>{" "}
                      <Money value={line.lineTotal} />
                      {line.reason ? <span className="block text-xs text-ink-500">{line.reason}</span> : null}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-sm font-medium">Total <Money value={option.total} /></p>
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-500">Every line is a price book item at your price book&apos;s price. Tax is added on the estimate.</p>
          {latest.status === "applied" ? (
            <p className="text-sm">
              Made into a draft estimate.{" "}
              {outcome?.estimateId ? <a href={`/estimates/${outcome.estimateId}`} className="underline underline-offset-4">Open it to edit and send</a> : null}
            </p>
          ) : writes ? (
            <div className="flex flex-wrap gap-3">
              <ActionForm action={makeEstimate} submit="Make the estimate" hidden={{ id: latest.id, jobId }} className="flex items-center" />
              <ActionForm action={setOptionsAside} submit="Set aside" hidden={{ id: latest.id, jobId }} tone="quiet" className="flex items-center" />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
