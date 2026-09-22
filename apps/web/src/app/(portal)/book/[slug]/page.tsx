import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { booking } from "@opentradesos/api/services";
import { BookingFlow } from "./BookingFlow";

export const dynamic = "force-dynamic";

/**
 * The booking widget, on its own page.
 *
 * Public and unauthenticated. The company is resolved from the slug in the
 * URL, which is the only identifier here: there is nothing else to change,
 * and what comes back is the list that company chose to publish.
 *
 * `force-dynamic` because availability is the whole product. A cached
 * availability page offers slots that were free when it was built, which is
 * the exact failure this design exists to avoid.
 */
export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let catalogue: Awaited<ReturnType<typeof booking.listServices>>;
  try {
    catalogue = await booking.listServices(getDb(), { organizationSlug: slug });
  } catch {
    notFound();
  }

  if (catalogue.services.length === 0) {
    return (
      <div className="rounded-md border border-steel-200 bg-canvas p-8 text-center">
        <h1 className="text-xl font-semibold">{catalogue.organizationName}</h1>
        <p className="mt-3 text-sm text-ink-700">
          Online booking is not open right now. Give us a call and we will get you on
          the schedule.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">{catalogue.organizationName}</h1>
        <p className="mt-1 text-sm text-ink-500">Pick a service and a time that works.</p>
      </header>
      <BookingFlow slug={slug} services={catalogue.services} />
    </div>
  );
}
