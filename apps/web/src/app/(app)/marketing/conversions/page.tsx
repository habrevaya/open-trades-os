import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { adPlatforms } from "@opentradesos/api/services";
import { marketing as mk } from "@opentradesos/core";
import { PageHeader } from "@/components/Table";
import { todayIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * TELLING THE AD ACCOUNTS WHICH CLICKS BECAME WORK
 *
 * An ads platform optimises towards whatever it is told a conversion is. Left
 * alone it is told about form fills, learns to buy form fills, and a company
 * pays more and more for people who were never going to book. Uploading the
 * booked JOB, with its revenue, against the click that produced it is what
 * makes the account bid towards work.
 *
 * A file for a platform that is not connected, because it works today with
 * no developer token, and Google Ads, Meta and Microsoft Advertising accept an offline
 * conversion upload in exactly this shape. A connected one sends by itself. The model splits the money between platforms
 * when both touched a job, and it is named here because this is the one place
 * a modelling choice becomes money an ad account spends.
 */
export default async function ConversionsPage() {
  const user = await requireSetupUser();
  /**
   * A connected platform that is sending replaces its file. Said at the top,
   * because uploading the file as well is the easiest way to report a job
   * twice; the file leaves out every job a connection has already sent, so
   * doing both anyway cannot double one.
   */
  const sending = (await adPlatforms.platforms({ actor: user.actor, db: getDb() }))
    .filter((p) => (p.provider === "google_ads" || p.provider === "meta_ads" || p.provider === "bing_ads") && p.status === "connected"
      && !p.notices.some((n) => n.includes("not being sent")));
  const today = todayIn(user.organizationTimezone);
  const monthAgo = new Date(Date.parse(`${today}T12:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <PageHeader title="Conversions" />
      <p className="mt-2 text-sm text-ink-700">
        Jobs booked in the dates you pick, each with the click id the platform matches on and its
        share of the job&rsquo;s invoiced revenue. A job not invoiced yet is left out rather than sent at
        nothing, which would teach the account that the click was worthless; it goes in a later file.
      </p>
      {sending.length > 0 && (
        <p role="status" className="mt-4 rounded border border-steel-200 bg-steel-100 px-3 py-2 text-sm text-ink-900">
          {sending.map((p) => p.label).join(" and ")} {sending.length === 1 ? "is" : "are"} connected and
          sent paid jobs by {sending.length === 1 ? "itself" : "themselves"}, so there is no file to upload for{" "}
          {sending.length === 1 ? "it" : "them"}. Jobs already sent are left out of the files below. What was
          sent is on <Link href="/marketing/platforms/sends" className="underline underline-offset-4">Conversions sent</Link>.
        </p>
      )}
      <form method="get" action="/marketing/conversions/download" className="mt-6 space-y-4 rounded-md border border-steel-200 p-4">
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-700">From</span>
            <input type="date" name="from" defaultValue={monthAgo} required className="h-9 rounded border border-steel-300 px-2" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-700">To</span>
            <input type="date" name="to" defaultValue={today} required className="h-9 rounded border border-steel-300 px-2" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-700">Split the money by</span>
            <select name="model" defaultValue="position_based" className="h-9 rounded border border-steel-300 px-2">
              {mk.ATTRIBUTION_MODEL_KEYS.map((key) => (
                <option key={key} value={key}>{mk.ATTRIBUTION_MODELS[key].label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="submit" name="format" value="google"
                  className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">
            Download for Google Ads
          </button>
          <button type="submit" name="format" value="meta"
                  className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium">
            Download for Meta
          </button>
          <button type="submit" name="format" value="microsoft"
                  className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium">
            Download for Microsoft Advertising
          </button>
        </div>
      </form>
    </div>
  );
}
