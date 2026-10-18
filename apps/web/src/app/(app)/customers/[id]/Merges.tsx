import { customerLifecycle, type ServiceContext } from "@opentradesos/api/services";
import { can, customerMerge } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { undoMerge } from "./merge-actions";

/**
 * THE RECORDS MERGED INTO THIS ONE, AND TAKING ONE BACK
 *
 * Each merge says who did it, when, and what it moved. One done in the last
 * thirty days with nothing in the way offers "Undo this merge"; one that
 * cannot be undone says every reason why instead, because a missing button
 * reads as a permission somebody lacks. Only for whoever may merge, which is
 * who may take one back.
 */
export async function Merges({ ctx, customerId, timezone }: { ctx: ServiceContext; customerId: string; timezone: string }) {
  if (!can(ctx.actor, "customer:merge")) return null;
  const { merges } = await customerLifecycle.merges(ctx, { id: customerId });
  if (merges.length === 0) return null;
  const day = (at: string) => formatIn(at, timezone, { month: "short", day: "numeric", year: "numeric" });

  return (
    <section aria-label="Merged into this record" className="mt-10">
      <h2 className="text-base font-semibold">Merged into this record</h2>
      <ul className="mt-3 space-y-3">
        {merges.map((merge) => (
          <li key={merge.id} className="rounded-md border border-steel-200 bg-canvas p-3 text-sm">
            <p className="text-ink-900">
              {merge.undone ? (
                <a href={`/customers/${merge.merged.id}`} className="font-medium underline underline-offset-4">{merge.merged.name}</a>
              ) : (
                <span className="font-medium">{merge.merged.name}</span>
              )}
              {" "}was merged in on {day(merge.mergedAt)}{merge.by?.name ? ` by ${merge.by.name}` : ""}.
              {merge.reason ? ` "${merge.reason}"` : ""}
            </p>
            {merge.moved.length > 0 && (
              <p className="mt-1 text-ink-700">It brought {customerMerge.counted(merge.moved)}.</p>
            )}
            {merge.stayed.length > 0 && (
              <div className="mt-1 text-ink-700">
                <p>Stayed with {merge.merged.name}:</p>
                <ul className="list-disc pl-5" aria-label="Stayed with the duplicate">
                  {merge.stayed.map((group) => (
                    <li key={`${group.label}-${group.why}`}>{customerMerge.counted([group])}. {group.why}</li>
                  ))}
                </ul>
              </div>
            )}
            {merge.undone ? (
              <p className="mt-1 text-ink-700">
                Undone on {day(merge.undone.at)}{merge.undone.by?.name ? ` by ${merge.undone.by.name}` : ""}.
                {merge.undone.reason ? ` "${merge.undone.reason}"` : ""}
              </p>
            ) : merge.canUndo ? (
              <ActionForm action={undoMerge} submit="Undo this merge" tone="quiet"
                          hidden={{ customerId, id: merge.id }} className="mt-2 flex flex-wrap items-end gap-2">
                <p className="w-full text-ink-700">
                  Undoing moves back exactly what the merge brought, and {merge.merged.name} is a customer of their
                  own again. Anything written to this record since stays here. Possible until {day(merge.undoableUntil)}.
                </p>
                <TextField label="Why, if you want to say" name="reason" maxLength={500} className="w-72" />
              </ActionForm>
            ) : (
              <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-700" aria-label="Why it cannot be undone">
                {merge.blockedBy.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
