import type { financing } from "@opentradesos/api/services";
import { ActionForm } from "@/components/ActionForm";
import { applyForFinancing } from "./financing-actions";

type Offer = financing.OfferView;

const WHERE: Record<string, string> = {
  sent: "Your financing application is open. Pick up where you left off.",
  applied: "Your financing application is with the lender.",
  approved: "The lender approved your financing. Finish on the lender's page if you have not yet.",
  funded: "This was paid with financing.",
  declined: "The lender did not approve the last application.",
  expired: "The last financing application expired. You can start a new one.",
  cancelled: "The last financing application was cancelled.",
};

/**
 * PAY OVER TIME, on the customer's invoice or estimate.
 *
 * The figure is never shown without its sentence, which names the lender and
 * says it is subject to approval and that their own terms may differ. The
 * button takes them to the lender's page; the decision is the lender's.
 */
export function PayOverTime({
  token, lender, options, application,
}: {
  token: string;
  lender: string;
  /** One entry for an invoice; one per option for an estimate. */
  options: { optionId: string | null; name: string | null; offer: Offer | null; applicable: boolean }[];
  application: { status: string; statusLabel: string; applicationUrl: string | null } | null;
}) {
  const funded = application?.status === "funded";
  const live = application?.applicationUrl ?? null;
  const applicable = options.filter((o) => o.applicable);
  if (!funded && applicable.length === 0) return null;

  return (
    <section aria-label="Pay over time" className="rounded-md border border-steel-200 bg-canvas p-5 text-sm">
      <h2 className="text-xs uppercase tracking-[0.08em] text-ink-500">Pay over time</h2>
      {application ? <p className="mt-2 font-medium text-ink-900">{WHERE[application.status] ?? application.statusLabel}</p> : null}
      {!funded && (
        <>
          <ul className="mt-2 space-y-1 text-ink-700">
            {applicable.map((o) => (
              <li key={o.optionId ?? "invoice"}>
                {o.name ? <span className="font-medium text-ink-900">{o.name}: </span> : null}
                {o.offer ? o.offer.sentence : `You can apply to pay this over time with ${lender}, if ${lender} approves.`}
              </li>
            ))}
          </ul>
          {live ? (
            <p className="mt-3">
              <a href={live} className="inline-flex h-10 items-center rounded bg-ink-900 px-4 font-medium text-white">
                Continue your application
              </a>
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-3">
              {applicable.map((o) => (
                <ActionForm key={o.optionId ?? "invoice"} action={applyForFinancing}
                            submit={o.name && applicable.length > 1 ? `Apply for financing: ${o.name}` : "Apply for financing"}
                            hidden={{ token, ...(o.optionId ? { optionId: o.optionId } : {}) }}
                            className="space-y-2" />
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-ink-500">
            You apply on {lender}&rsquo;s own page, and {lender} decides. Nothing about your credit is shared with us.
          </p>
        </>
      )}
    </section>
  );
}
