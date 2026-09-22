import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { portal } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * The tracking page.
 *
 * The heaviest read in the product: a customer refreshes this through a four
 * hour arrival window. The timeline comes back already written rather than
 * assembled here, so this stays one indexed read however many times it is
 * reloaded.
 */
export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let job: Awaited<ReturnType<typeof portal.viewJob>>;
  try {
    job = await portal.viewJob(getDb(), { token });
  } catch {
    notFound();
  }

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{job.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">{job.summary ?? `Job #${job.jobNumber}`}</h1>
        <p className="mt-1 text-sm text-ink-500">{job.propertyAddress}</p>
      </header>

      <div className="rounded-md border border-steel-200 bg-canvas p-6 text-center">
        <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Status</p>
        {/*
          Rendered as the service worded it. Capitalizing here title-cased
          every word, so "On the way" read "On The Way".
        */}
        <p className="mt-2 text-lg font-medium">{job.status}</p>
        {job.scheduledDate && (
          <p className="mt-2 text-sm text-ink-700">
            {new Date(`${job.scheduledDate}T12:00:00Z`).toLocaleDateString("en-US", {
              weekday: "long", month: "long", day: "numeric",
            })}
            {job.arrivalWindow ? `, ${job.arrivalWindow}` : ""}
          </p>
        )}
        {job.etaMinutes !== null && (
          <p className="mt-3 text-sm font-medium">
            About {job.etaMinutes} minutes away.
          </p>
        )}
        {job.technician && (
          <div className="mt-5 flex items-center justify-center gap-3">
            {job.technician.photoUrl && (
              /* A plain img, not next/image. The photo is at whatever URL the
                 self hoster's storage gave it, and next/image needs those
                 hosts declared at build time, which nobody deploying this can
                 know in advance. */
              <img
                src={job.technician.photoUrl}
                alt=""
                className="h-10 w-10 rounded-full object-cover"
              />
            )}
            {/* First name only. A last name and a phone number are not the
                customer's to have, and a technician cannot opt out of this page. */}
            <span className="text-sm">{job.technician.firstName} is on this one.</span>
          </div>
        )}
      </div>

      {job.timeline.length > 0 && (
        <ol className="space-y-0 rounded-md border border-steel-200 bg-canvas p-6">
          {job.timeline.map((event, i) => (
            <li key={`${event.occurredAt}-${i}`} className="flex gap-4 pb-6 last:pb-0">
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    i === 0 ? "bg-ink-900" : "bg-steel-300"
                  }`}
                />
                {i < job.timeline.length - 1 && (
                  <span className="mt-1 w-px flex-1 bg-steel-200" />
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">{event.headline}</p>
                {event.detail && <p className="mt-0.5 text-sm text-ink-700">{event.detail}</p>}
                <p className="mt-0.5 text-xs text-ink-500">
                  {new Date(event.occurredAt).toLocaleString("en-US", {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
