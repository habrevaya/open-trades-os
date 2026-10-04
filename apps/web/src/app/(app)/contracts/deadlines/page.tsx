import { inArray } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inTenant, obligations } from "@opentradesos/api/services";
import { deadlines } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

const SOON = 24 * 60;

const away = (minutes: number): string =>
  minutes < 60 ? `${minutes} min left` : minutes < 60 * 48 ? `${Math.round(minutes / 60)} h left` : `${Math.round(minutes / 1440)} days left`;

/**
 * WHAT IS ABOUT TO BREACH
 *
 * Every live deadline the contracts have started, soonest first, cut into
 * three: already past, due within a day, and later. A response clock with
 * forty minutes left is the one thing on this page worth stopping for, so it
 * sits at the top in its own block rather than in a list sorted by a column
 * nobody clicked.
 *
 * Read from the clock on every load, never from a stored breach, and a clock
 * already met since the worker last went round is not shown at all: the
 * technician who arrived at ten to the hour is not a breach at the hour.
 *
 * Each one also raises a task in the office queue before it runs out, where
 * the company's escalation rules pick it up if nobody does.
 */
export default async function DeadlinesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const live = await obligations.open(ctx, { limit: 300 });

  const jobIds = live.filter((o) => o.entityType === "job").map((o) => o.entityId);
  const jobsById = new Map(jobIds.length === 0 ? [] : (await inTenant(ctx, (tx) =>
    tx.select({ id: schema.job.id, number: schema.job.number, summary: schema.job.summary })
      .from(schema.job).where(inArray(schema.job.id, jobIds)))).map((j) => [j.id, j] as const));

  const past = live.filter((o) => o.overdue);
  const soon = live.filter((o) => !o.overdue && o.minutesRemaining <= SOON);
  const later = live.filter((o) => !o.overdue && o.minutesRemaining > SOON);

  const row = (item: (typeof live)[number]) => {
    const job = item.entityType === "job" ? jobsById.get(item.entityId) : undefined;
    const href = job ? `/jobs/${job.id}` : item.entityType === "invoice" ? `/invoices/${item.entityId}` : null;
    return (
      <li key={item.id} className="bg-canvas p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium">{deadlines.deadlineLabel(item.kind)}</span>
          {job && <a href={`/jobs/${job.id}`} className="text-sm text-ink-700 hover:underline">Job {job.number} · {job.summary}</a>}
          {!job && href && <a href={href} className="text-sm text-ink-700 hover:underline">Open the {item.entityType}</a>}
          {item.overdue
            ? <Chip tone="danger">Past due</Chip>
            : <Chip tone={item.minutesRemaining <= SOON ? "warning" : "neutral"}>{away(item.minutesRemaining)}</Chip>}
          {item.escalatedAt && <Chip tone="info">In the task queue</Chip>}
        </div>
        <p className="mt-1 text-sm text-ink-700">{item.consequence}</p>
        <p className={`mt-1 text-xs ${item.overdue ? "text-red-600" : "text-ink-500"}`}>
          Due {formatIn(item.dueAt, user.organizationTimezone)}
        </p>
      </li>
    );
  };

  const block = (title: string, items: typeof live) => items.length > 0 && (
    <section aria-label={title} className="mt-6">
      <h2 className="text-base font-semibold">{title} <span className="text-sm font-normal text-ink-500">{items.length}</span></h2>
      <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
        {items.map(row)}
      </ul>
    </section>
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Deadlines" count={live.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Response times, invoicing windows and claim deadlines from your
        contracts, and anything else the product is holding open for a
        decision. A clock is cleared by doing the thing: booking the visit,
        arriving, finishing, invoicing, filing the claim.
      </p>
      {live.length === 0 ? (
        <Empty title="Nothing is running">
          A contract with response times or an invoicing window starts its
          clocks on every job that runs under it.
        </Empty>
      ) : (
        <>
          {block("Past due", past)}
          {block("Due within a day", soon)}
          {block("Later", later)}
        </>
      )}
    </div>
  );
}
