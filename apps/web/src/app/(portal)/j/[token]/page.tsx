import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { liveLocation, portal } from "@opentradesos/api/services";
import { tileSource } from "@/lib/map-tiles";
import { PortalBrand } from "../../PortalBrand";
import { LiveTracker } from "./LiveTracker";

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
  let live: Awaited<ReturnType<typeof liveLocation.liveTracking>>;
  try {
    job = await portal.viewJob(getDb(), { token });
  } catch {
    notFound();
  }
  try {
    live = await liveLocation.liveTracking(getDb(), { token });
  } catch {
    /**
     * The live part failing (a routing service timing out, say) must not
     * take the customer's whole page with it: the page without the pin is
     * still the page they came for.
     */
    live = {
      tracking: false, status: "not_on_the_way", etaMinutes: null, etaBasis: null, technician: null,
      position: null, destination: null, explanation: "",
    };
  }
  /** The live part takes over once the technician is on the way: their name, the ETA, the pin, and then that they are here. */
  const showLive = live.status === "on_the_way" || live.status === "arrived";
  /**
   * Arriving does not move a visit out of on the way (work starting does), so
   * the job's own status would still say "On the way" with the van in the
   * drive. The live read knows they arrived.
   */
  const status = live.status === "arrived" && job.status === "On the way" ? "Arrived" : job.status;
  /** The live read carries the photo when one is set; the job's own read never has. */
  const technician = live.technician ?? job.technician;

  return (
    <PortalBrand token={token}>
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
        <p className="mt-2 text-lg font-medium">{status}</p>
        {job.scheduledDate && (
          <p className="mt-2 text-sm text-ink-700">
            {new Date(`${job.scheduledDate}T12:00:00Z`).toLocaleDateString("en-US", {
              weekday: "long", month: "long", day: "numeric",
            })}
            {job.arrivalWindow ? `, ${job.arrivalWindow}` : ""}
          </p>
        )}
        {/*
          Asking, not moving: the page it opens says so before anything is
          pressed. Offered whenever there is a booked time to change; whether
          this one still can be is the service's answer on that page.
        */}
        {job.scheduledDate && !showLive && (
          <p className="mt-3 text-sm">
            <a href={`/j/${token}/change`} className="text-ink-700 underline underline-offset-4">
              Need to change or cancel this visit?
            </a>
          </p>
        )}
        {!showLive && technician && (
          <div className="mt-5 flex items-center justify-center gap-3">
            {technician.photoUrl && (
              /* A plain img, not next/image. The photo is at whatever URL the
                 self hoster's storage gave it, and next/image needs those
                 hosts declared at build time, which nobody deploying this can
                 know in advance. */
              <img
                src={technician.photoUrl}
                alt=""
                className="h-10 w-10 rounded-full object-cover"
              />
            )}
            {/* First name only. A last name and a phone number are not the
                customer's to have, and a technician cannot opt out of this page. */}
            <span className="text-sm">{technician.firstName} is on this one.</span>
          </div>
        )}
      </div>

      {showLive && <LiveTracker token={token} initial={live} tiles={tileSource()} />}

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

      {job.photos.length > 0 && (
        <section aria-label="Photos" className="rounded-md border border-steel-200 bg-canvas p-5">
          <h2 className="text-xs uppercase tracking-[0.08em] text-ink-500">Photos</h2>
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {job.photos.map((photo) => (
              <li key={photo.id}>
                {/*
                  Through this link, by id. The token is already in this
                  page's address, and the route checks the photograph is on
                  this job and shown to the customer before it sends a byte.
                */}
                <a href={`/j/${token}/photos/${photo.id}`} className="block">
                  <img
                    src={`/j/${token}/photos/${photo.id}`}
                    alt={photo.phase ? `${photo.phase[0]!.toUpperCase()}${photo.phase.slice(1)} photo` : "Job photo"}
                    loading="lazy"
                    className="aspect-square w-full rounded object-cover"
                  />
                </a>
                {photo.phase && <span className="mt-1 block text-xs capitalize text-ink-500">{photo.phase}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </PortalBrand>
  );
}
