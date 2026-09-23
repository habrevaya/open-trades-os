import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks, obligations, inTenant } from "@opentradesos/api/services";
import { schema } from "@opentradesos/db";
import { inArray } from "drizzle-orm";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Empty, PageHeader } from "@/components/Table";
import { TASK_PRIORITY, label } from "@/lib/labels";
import { TaskActions } from "./TaskActions";
import { ObligationActions } from "./ObligationActions";

export const dynamic = "force-dynamic";

/**
 * THE OFFICE QUEUE
 *
 * Three views and no more, because the questions somebody has when they open
 * this are "what is mine", "what has nobody taken" and "what is late". A
 * filter builder here would be a way to avoid deciding which of those matters.
 *
 * Mine includes unclaimed work on purpose. A list that hides it makes the
 * unclaimed work nobody's, which is how a queue quietly becomes a backlog.
 */
const VIEWS = [
  { key: "mine", label: "Mine and unclaimed" },
  { key: "unassigned", label: "Unclaimed" },
  { key: "overdue", label: "Late" },
  { key: "all", label: "Everything" },
] as const;

const TONE = {
  urgent: "danger", high: "warning", normal: "neutral", low: "neutral",
} as const;

/**
 * How long is left, in the coarsest unit that is still true.
 *
 * "In 3 days" beats "in 4,321 minutes" for the same reason a dispatch board
 * shows a time and not an epoch: the number is read at a glance and acted on
 * or not.
 */
function hoursAway(minutes: number): string {
  if (minutes < 60) return `In ${minutes} min`;
  if (minutes < 60 * 48) return `In ${Math.round(minutes / 60)} h`;
  return `In ${Math.round(minutes / 1440)} days`;
}

/** Where a task about a record actually goes. */
const LINKS: Record<string, (id: string) => string> = {
  job: (id) => `/jobs/${id}`,
  customer: (id) => `/customers/${id}`,
  invoice: (id) => `/invoices/${id}`,
  conversation: (id) => `/inbox/${id}`,
};

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const user = await requireSetupUser();
  const params = await searchParams;
  const view = (VIEWS.find((v) => v.key === params.view)?.key ?? "mine");

  const ctx = { actor: user.actor, db: getDb() };
  const page = await tasks.list(ctx, { view, limit: 100 });
  const writes = can(user.actor, "task:write");

  /**
   * Deadlines, above the queue.
   *
   * `obligation` had one writer and no reader: a technician completing work
   * on a visit that had already been cancelled raised one saying "confirm
   * whether to bill it", and nothing ever showed it to anybody. The money is
   * real, so it goes at the top rather than behind a tab.
   */
  const due = await obligations.open(ctx, { limit: 50 });

  /**
   * A visit has no screen of its own; it is shown inside its job. The
   * obligation keeps the visit id because a job can carry several and only
   * one of them is the one in question, so the resolution to a job happens
   * here, where the link is, rather than by the raiser throwing away which
   * visit it was.
   */
  const visitIds = due.filter((o) => o.entityType === "visit").map((o) => o.entityId);
  const jobOfVisit = new Map<string, string>(
    visitIds.length === 0 ? [] : (await inTenant(ctx, (tx) =>
      tx.select({ id: schema.visit.id, jobId: schema.visit.jobId })
        .from(schema.visit)
        .where(inArray(schema.visit.id, visitIds)),
    )).map((v) => [v.id, v.jobId] as const),
  );

  /** Where a deadline about a record goes, with the visit hop applied. */
  const deadlineLink = (entityType: string, entityId: string): string | undefined =>
    entityType === "visit"
      ? (jobOfVisit.has(entityId) ? `/jobs/${jobOfVisit.get(entityId)}` : undefined)
      : LINKS[entityType]?.(entityId);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Tasks" count={page.data.length} />

      {due.length > 0 && (
        <section className="mt-6">
          <h2 className="text-base font-semibold">Deadlines</h2>
          <p className="mt-1 text-sm text-ink-700">
            Not tasks somebody raised. These are commitments the product is
            tracking: an SLA, a billing window, a decision it is holding open.
          </p>
          <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
            {due.map((item) => (
              <li key={item.id} className="bg-canvas p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{item.consequence ?? item.kind}</span>
                  {item.overdue
                    ? <Chip tone="danger">Past due</Chip>
                    : <Chip tone="neutral">{hoursAway(item.minutesRemaining)}</Chip>}
                  {item.escalatedAt && <Chip tone="warning">Escalated</Chip>}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 text-sm text-ink-500">
                  <span className={item.overdue ? "text-red-600" : undefined}>
                    Due {formatIn(item.dueAt, user.organizationTimezone)}
                  </span>
                  <span className="font-mono text-xs">{item.kind}</span>
                  {deadlineLink(item.entityType, item.entityId) && (
                    <a
                      href={deadlineLink(item.entityType, item.entityId)}
                      className="text-ink-700 hover:underline"
                    >
                      {item.entityType === "visit" ? "Open the job" : `Open the ${item.entityType}`}
                    </a>
                  )}
                </div>
                {writes && <ObligationActions id={item.id} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <a
            key={v.key}
            href={`/tasks?view=${v.key}`}
            className={`inline-flex h-8 items-center rounded px-3 text-sm ${
              v.key === view
                ? "bg-ink-900 font-medium text-white"
                : "border border-steel-300 text-ink-700 hover:bg-steel-100"
            }`}
          >
            {v.label}
          </a>
        ))}
      </div>

      {page.data.length === 0 ? (
        <Empty title={view === "overdue" ? "Nothing is late" : "Nothing in this queue"}>
          {view === "overdue"
            ? "Tasks appear here once their due date passes."
            : "Automations raise most of these: an estimate nobody answered, a payment that failed."}
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {page.data.map((task) => {
            const link = task.entityType && task.entityId
              ? LINKS[task.entityType]?.(task.entityId)
              : undefined;
            return (
              <li key={task.id} className="bg-canvas p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{task.title}</span>
                  {task.priority !== "normal" && (
                    <Chip tone={TONE[task.priority]}>{label(TASK_PRIORITY, task.priority)}</Chip>
                  )}
                  {task.overdue && <Chip tone="danger">Late</Chip>}
                  {task.assigneeUserId === null && <Chip tone="info">Unclaimed</Chip>}
                  {/*
                    Named, because "why is this in my queue" is the first
                    question about a task nobody remembers creating.
                  */}
                  {task.raisedByRunId && (
                    <span className="text-xs text-ink-500">raised by an automation</span>
                  )}
                </div>

                {task.body && <p className="mt-1 text-sm text-ink-700">{task.body}</p>}

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-500">
                  {task.dueAt && (
                    <span className={task.overdue ? "text-red-600" : undefined}>
                      Due {formatIn(task.dueAt, user.organizationTimezone)}
                    </span>
                  )}
                  {task.assigneeName && <span>{task.assigneeName}</span>}
                  {task.queue && <span>{task.queue}</span>}
                  {/*
                    The link is the point of attaching a task to a record:
                    following it up opens the thing, not a description of it.
                  */}
                  {link && (
                    <a href={link} className="text-ink-700 hover:underline">
                      Open the {task.entityType}
                    </a>
                  )}
                </div>

                <TaskActions
                  id={task.id}
                  claimable={task.assigneeUserId === null}
                  closable={writes}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
