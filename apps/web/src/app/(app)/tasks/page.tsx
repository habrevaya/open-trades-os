import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks, obligations, visitChanges, inTenant, taskRules } from "@opentradesos/api/services";
import { schema } from "@opentradesos/db";
import { inArray } from "drizzle-orm";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Empty, PageHeader } from "@/components/Table";
import { TASK_PRIORITY, label } from "@/lib/labels";
import { TaskActions } from "./TaskActions";
import { ObligationActions } from "./ObligationActions";
import { VisitChangeDecision } from "@/components/VisitChangeDecision";
import { approveVisitChange, declineVisitChange } from "../jobs/[id]/actions";
import { ActionForm, TextField, TextArea, Select } from "@/components/ActionForm";
import { addTask } from "./rule-actions";

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
  /** Raised by the estimate follow up, and by a renewal notice that could not go. */
  estimate: (id) => `/estimates/${id}`,
  agreement: (id) => `/agreements/${id}`,
  /** An escalation's notice is about the late task, and opens it. */
  task: (id) => `/tasks/${id}`,
  /** Raised when somebody reports an incident, and by every follow up added to one. */
  incident_report: (id) => `/compliance/incidents/${id}`,
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
   * A customer's request to move or cancel a visit is answered here, not
   * marked done: the answer is what moves the visit and tells the customer,
   * and a task ticked off without it would leave both undone with the queue
   * saying otherwise. The request is read once for the page.
   */
  const changeIds = page.data
    .filter((t) => t.entityType === "visit_change_request" && t.entityId)
    .map((t) => t.entityId!);
  const changes = new Map(
    changeIds.length > 0 && can(user.actor, "visit:read")
      ? (await visitChanges.list(ctx, { ids: changeIds })).map((r) => [r.id, r] as const)
      : [],
  );

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

  /**
   * A unit has no page of its own either; it is shown on its address. A
   * warranty follow up keeps the unit's id, and the hop to the address is
   * made here for the same reason as the visit's.
   */
  const unitIds = page.data.filter((t) => t.entityType === "equipment" && t.entityId).map((t) => t.entityId!);
  const addressOfUnit = new Map<string, string>(
    unitIds.length === 0 ? [] : (await inTenant(ctx, (tx) =>
      tx.select({ id: schema.equipment.id, propertyId: schema.equipment.propertyId })
        .from(schema.equipment)
        .where(inArray(schema.equipment.id, unitIds)),
    )).map((u) => [u.id, u.propertyId] as const),
  );
  const people = writes ? await taskRules.assignable(ctx) : [];

  /** Where a deadline about a record goes, with the visit hop applied. */
  const deadlineLink = (entityType: string, entityId: string): string | undefined =>
    entityType === "visit"
      ? (jobOfVisit.has(entityId) ? `/jobs/${jobOfVisit.get(entityId)}` : undefined)
      : LINKS[entityType]?.(entityId);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Tasks" count={page.data.length} />

      {writes && (
        <details className="mt-4 rounded-md border border-steel-200 bg-canvas p-4">
          <summary className="cursor-pointer text-sm font-medium">Add a task</summary>
          <ActionForm action={addTask} submit="Add task" className="mt-3 space-y-3">
            <TextField label="What needs doing" name="title" required maxLength={300} />
            <TextArea label="More detail" name="body" rows={2} />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Due" name="dueAt" type="datetime-local" />
              <Select label="For" name="assigneeUserId"
                      options={[{ value: "", label: "Nobody yet (the queue)" }, ...people.map((p) => ({ value: p.userId, label: p.name }))]} />
            </div>
            <TextArea label="Checklist, one item a line" name="checklist" rows={3} />
          </ActionForm>
        </details>
      )}

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
            const change = task.entityType === "visit_change_request" && task.entityId
              ? changes.get(task.entityId)
              : undefined;
            const link = change
              ? `/jobs/${change.jobId}`
              : task.entityType === "equipment" && task.entityId
                ? (addressOfUnit.has(task.entityId) ? `/properties/${addressOfUnit.get(task.entityId)}` : undefined)
                : task.entityType && task.entityId
                  ? LINKS[task.entityType]?.(task.entityId)
                  : undefined;
            return (
              <li key={task.id} className="bg-canvas p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <a href={`/tasks/${task.id}`} className="font-medium hover:underline">{task.title}</a>
                  {task.priority !== "normal" && (
                    <Chip tone={TONE[task.priority]}>{label(TASK_PRIORITY, task.priority)}</Chip>
                  )}
                  {task.overdue && <Chip tone="danger">Late</Chip>}
                  {task.escalatedAt && <Chip tone="warning">Escalated</Chip>}
                  {task.checklistTotal > 0 && (
                    <Chip tone={task.checklistDone === task.checklistTotal ? "success" : "neutral"}>
                      {`${task.checklistDone} of ${task.checklistTotal} ticked`}
                    </Chip>
                  )}
                  {task.templateId && <span className="text-xs text-ink-500">recurring</span>}
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
                      {change ? "Open the job"
                        : task.entityType === "equipment" ? "Open the address"
                        : task.entityType === "task" ? "Open the late task"
                        : task.entityType === "incident_report" ? "Open the incident report"
                        : `Open the ${task.entityType}`}
                    </a>
                  )}
                </div>

                {change && change.status === "pending" ? (
                  <div className="mt-3">
                    <VisitChangeDecision
                      request={change}
                      timezone={user.organizationTimezone}
                      approve={approveVisitChange}
                      decline={declineVisitChange}
                      canDecide={can(user.actor, "visit:reschedule")}
                    />
                  </div>
                ) : null}

                {/*
                  A task with a checklist is closed from its own page, where
                  the items are and where an unticked one asks for a reason.
                */}
                <TaskActions
                  id={task.id}
                  claimable={task.assigneeUserId === null}
                  closable={(writes || task.assigneeUserId === user.actor.userId)
                    && !(change && change.status === "pending") && task.checklistTotal === 0}
                  dismissable={writes}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
