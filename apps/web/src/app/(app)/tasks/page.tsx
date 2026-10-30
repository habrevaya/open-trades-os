import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks, obligations, visitChanges, taskRules } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { LINKS, RECORD_NOUN } from "@/lib/record-links";
import { Chip } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Empty, PageHeader } from "@/components/Table";
import { TASK_PRIORITY, label } from "@/lib/labels";
import { TaskActions } from "./TaskActions";
import { ObligationActions } from "./ObligationActions";
import { OfferAgain, OfferWaiting, VisitChangeDecision } from "@/components/VisitChangeDecision";
import {
  approveVisitChange, declineVisitChange, proposeVisitChange, withdrawVisitChangeOffer,
} from "../jobs/[id]/actions";
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

  /** The times that could be offered instead, for each request to move still waiting, for somebody who may answer. */
  const offerable = new Map(can(user.actor, "visit:reschedule")
    ? await Promise.all([...changes.values()].filter((r) => r.status === "pending" && r.kind === "reschedule")
      .map(async (r) => [r.id, await visitChanges.proposalTimes(ctx, { id: r.id })] as const))
    : []);

  /**
   * THE TIMES OFFERED, FROM THE QUEUE. An offer waiting for the customer can
   * be taken back here, a time taken back can be offered again, and the task
   * raised when a customer said no to a time offers the next free times with
   * one press each. Nothing is offered by itself: each is a button.
   */
  const mayOffer = can(user.actor, "visit:reschedule");
  const offers = mayOffer
    ? await visitChanges.openOffers(ctx, {
      taskIds: page.data.filter((t) => t.entityType === "visit").map((t) => t.id),
    })
    : [];
  const saidNo = new Map(offers.filter((o) => o.status === "turned_down" && o.taskId).map((o) => [o.taskId!, o] as const));
  const waitingOffers = view === "mine" || view === "all" ? offers.filter((o) => o.status === "proposed") : [];
  const takenBack = view === "mine" || view === "all" ? offers.filter((o) => o.status === "withdrawn") : [];
  const againIds = [...saidNo.values(), ...takenBack].map((o) => o.id);
  const againTimes = new Map(await Promise.all(againIds.map(async (id) =>
    [id, {
      all: await visitChanges.proposalTimes(ctx, { id }),
      next: await visitChanges.nextTimes(ctx, { id, count: 3 }),
    }] as const)));

  /**
   * Deadlines, above the queue.
   *
   * `obligation` had one writer and no reader: a technician completing work
   * on a visit that had already been cancelled raised one saying "confirm
   * whether to bill it", and nothing ever showed it to anybody. The money is
   * real, so it goes at the top rather than behind a tab.
   */
  const due = await obligations.open(ctx, { limit: 50 });

  const people = writes ? await taskRules.assignable(ctx) : [];

  /**
   * Where a deadline about a record goes. A visit and a unit each have a
   * page of their own now, so a deadline about one opens it rather than its
   * job or its address.
   */
  const deadlineLink = (entityType: string, entityId: string): string | undefined =>
    LINKS[entityType]?.(entityId);

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
                      {`Open the ${item.entityType === "equipment" ? "unit" : item.entityType}`}
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

      {waitingOffers.length > 0 && (
        <section className="mt-6" aria-label="Times offered to customers">
          <h2 className="text-base font-semibold">Waiting for a customer to answer</h2>
          <p className="mt-1 text-sm text-ink-700">
            Times you offered. Nothing has moved. You can take one back here.
          </p>
          <div className="mt-3 space-y-3">
            {waitingOffers.map((offer) => (
              <OfferWaiting
                key={offer.id}
                offer={offer}
                timezone={user.organizationTimezone}
                withdraw={withdrawVisitChangeOffer}
                canDecide={mayOffer}
              />
            ))}
          </div>
        </section>
      )}

      {takenBack.length > 0 && (
        <section className="mt-6" aria-label="Times taken back">
          <h2 className="text-base font-semibold">Times you took back</h2>
          <p className="mt-1 text-sm text-ink-700">
            These customers still need a time. They stay here for two weeks, or until the visit has passed.
          </p>
          <div className="mt-3 space-y-3">
            {takenBack.map((request) => (
              <OfferAgain
                key={request.id}
                request={request}
                timezone={user.organizationTimezone}
                propose={proposeVisitChange}
                times={againTimes.get(request.id)?.all ?? []}
                next={againTimes.get(request.id)?.next ?? []}
              />
            ))}
          </div>
        </section>
      )}

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
            /** A customer's request to move a visit opens the visit it is about. */
            const link = change
              ? `/visits/${change.visitId}`
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
                      {change ? "Open the visit"
                        : task.entityType === "equipment" ? "Open the unit"
                        : task.entityType === "task" ? "Open the late task"
                        : task.entityType === "incident_report" ? "Open the incident report"
                        : `Open the ${RECORD_NOUN[task.entityType ?? ""] ?? task.entityType}`}
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
                      propose={proposeVisitChange}
                      times={offerable.get(change.id) ?? []}
                    />
                  </div>
                ) : null}

                {saidNo.get(task.id) ? (
                  <div className="mt-3">
                    <OfferAgain
                      request={saidNo.get(task.id)!}
                      timezone={user.organizationTimezone}
                      propose={proposeVisitChange}
                      times={againTimes.get(saidNo.get(task.id)!.id)?.all ?? []}
                      next={againTimes.get(saidNo.get(task.id)!.id)?.next ?? []}
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
