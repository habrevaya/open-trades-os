import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { portal } from "@opentradesos/api/services";
import { ApproveForm } from "./ApproveForm";

export const dynamic = "force-dynamic";

/**
 * The approval page.
 *
 * Rendered server side from the token in the URL and nothing else. There is no
 * customer id, no estimate id and no organization id anywhere in this route,
 * because the grant resolves all three; an id in the path is an id somebody
 * will change.
 *
 * `force-dynamic` matters here rather than being a default: a cached approval
 * page would serve one customer's quote to the next person who opened a link.
 */
export default async function EstimatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let estimate: Awaited<ReturnType<typeof portal.viewEstimate>>;
  try {
    estimate = await portal.viewEstimate(getDb(), { token });
  } catch {
    // Expired, revoked, spent and never issued all land here and all say the
    // same thing. Telling someone which one it was tells them which tokens
    // were once real.
    notFound();
  }

  const decided = estimate.status === "approved" || estimate.status === "declined"
    || estimate.status === "converted";

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{estimate.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {estimate.title ?? `Estimate #${estimate.number}`}
        </h1>
        <p className="mt-1 text-sm text-ink-500">{estimate.propertyAddress}</p>
      </header>

      {decided ? (
        <Decided estimate={estimate} />
      ) : (
        <ApproveForm token={token} estimate={estimate} />
      )}
    </div>
  );
}

function Decided({ estimate }: { estimate: Awaited<ReturnType<typeof portal.viewEstimate>> }) {
  const approved = estimate.status !== "declined";
  const chosen = estimate.options.find((o: { id: string }) => o.id === estimate.selectedOptionId);

  return (
    <div className="rounded-md border border-steel-200 bg-canvas p-6 text-center">
      <p className="text-lg font-medium">
        {approved ? "Thank you. This estimate is approved." : "This estimate was declined."}
      </p>
      {approved && chosen && (
        <p className="mt-2 text-sm text-ink-700">
          {chosen.name}, <span className="font-mono tabular-nums">${chosen.total}</span>
        </p>
      )}
      {approved && estimate.signerName && (
        <p className="mt-4 text-xs text-ink-500">
          Signed by {estimate.signerName}
          {estimate.decidedAt
            ? ` on ${new Date(estimate.decidedAt).toLocaleDateString("en-US", {
                month: "long", day: "numeric", year: "numeric",
              })}`
            : ""}
        </p>
      )}
      <p className="mt-6 text-sm text-ink-700">
        {estimate.organizationName} will be in touch. Any questions, reply to the message
        that brought you here.
      </p>
    </div>
  );
}
