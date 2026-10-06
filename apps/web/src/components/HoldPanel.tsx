import { can } from "@opentradesos/core";
import { retention, type ServiceContext } from "@opentradesos/api/services";
import { ActionForm } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { holdHere, liftHold } from "@/lib/hold-actions";

/**
 * KEEP THIS RECORD, ON ITS OWN PAGE
 *
 * Whether the record is on hold, why and since when, and the form to place or
 * lift one. A hold keeps a record from every retention purge whatever its age,
 * for a claim, a dispute or an inspector's letter. Shown to whoever may read
 * compliance records; placed and lifted by whoever may change them. Nothing at
 * all for anybody else, because a heading they cannot act on is noise.
 */
export async function HoldPanel({
  ctx, entityType, entityId, path, label, timezone,
}: {
  ctx: ServiceContext;
  entityType: "incident_report" | "safety_meeting" | "service_report" | "photo" | "call_recording";
  entityId: string;
  /** This page, so it shows the change. */
  path: string;
  /** What is kept, in the page's own words: "this report", "this job's photographs". */
  label: string;
  timezone: string;
}) {
  if (!can(ctx.actor, "compliance:read")) return null;
  const hold = await retention.holdOn(ctx, { entityType, entityId });
  const writes = can(ctx.actor, "compliance:write");
  return (
    <section aria-label={`Keep ${label}`} className="mt-6 rounded-md border border-steel-200 p-3 text-sm">
      {hold ? (
        <>
          <p><span className="font-medium">On hold:</span> {hold.reason}</p>
          <p className="text-xs text-ink-500">
            Since {formatIn(hold.placedAt, timezone)}. No retention purge removes {label} while it is held.
          </p>
          {writes ? (
            <ActionForm action={liftHold} submit="Lift the hold" tone="quiet" className="mt-2 flex flex-wrap items-center gap-2"
                        hidden={{ id: hold.id, path }}>
              <input name="note" placeholder="Why (optional)" aria-label="Why the hold is lifted"
                     className="h-9 w-56 rounded border border-steel-300 bg-canvas px-2 text-sm" />
            </ActionForm>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-ink-700">Not on hold: the retention rules apply to {label}.</p>
          {writes ? (
            <ActionForm action={holdHere} submit="Keep it" tone="quiet" className="mt-2 flex flex-wrap items-center gap-2"
                        hidden={{ entityType, entityId, path }}>
              <input name="reason" required placeholder="Why it is kept" aria-label={`Why ${label} is kept`}
                     className="h-9 w-56 rounded border border-steel-300 bg-canvas px-2 text-sm" />
            </ActionForm>
          ) : null}
        </>
      )}
    </section>
  );
}
