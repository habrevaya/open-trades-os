import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks, taskChecklist, taskRules, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { ActionForm, TextField } from "@/components/ActionForm";
import { TASK_PRIORITY, label } from "@/lib/labels";
import { formatIn } from "@/lib/dates";
import { tickItem, addItem, removeItem, finishTask } from "../rule-actions";

export const dynamic = "force-dynamic";

/**
 * ONE TASK, WITH ITS CHECKLIST
 *
 * Where the items are ticked off, one at a time and each saying who, and
 * where a task with items still unticked is closed: done with a reason kept
 * apart from the outcome, or dismissed. Also what escalation has done to it,
 * because "why is my manager asking about this" deserves an answer on the
 * page rather than in the audit log.
 */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const task = await tasks.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const list = await taskChecklist.list(ctx, { taskId: id });
  const escalations = await taskRules.escalationsOf(ctx, { taskId: id });
  const writes = can(user.actor, "task:write");
  const mine = task.assigneeUserId === user.actor.userId;
  const ticks = writes || mine;
  const open = task.completedAt === null;
  const tz = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/tasks">Tasks</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-semibold">{task.title}</h1>
        {task.overdue ? <Chip tone="danger">Late</Chip> : null}
        {task.escalatedAt ? <Chip tone="warning">Escalated</Chip> : null}
        {!open ? <Chip tone="neutral">{task.status === "dismissed" ? "Dismissed" : "Done"}</Chip> : null}
      </div>
      {task.body ? <p className="mt-2 max-w-prose text-sm text-ink-700">{task.body}</p> : null}

      <Facts>
        <Fact label="Due">{task.dueAt ? formatIn(task.dueAt, tz) : null}</Fact>
        <Fact label="With">{task.assigneeName ?? (task.queue ? `The ${task.queue} queue` : "Nobody yet")}</Fact>
        <Fact label="Priority">{label(TASK_PRIORITY, task.priority)}</Fact>
        <Fact label="Outcome">{task.outcome}</Fact>
        <Fact label="Closed with items unticked because">{task.checklistOverrideReason}</Fact>
      </Facts>

      <section aria-label="Checklist" className="mt-8">
        <h2 className="text-base font-semibold">Checklist</h2>
        {list.items.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No items.</p>
        ) : (
          <ul className="mt-2 divide-y divide-steel-200 rounded-md border border-steel-200">
            {list.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 bg-canvas px-4 py-2">
                <span className={item.done ? "text-ink-500 line-through" : "text-ink-900"}>{item.label}</span>
                {item.done && item.doneBy ? <span className="text-xs text-ink-500">by {item.doneBy}</span> : null}
                {open && ticks ? (
                  <ActionForm action={tickItem} submit={item.done ? `Untick ${item.label}` : `Tick ${item.label}`} tone="quiet"
                              hidden={{ taskId: id, itemId: item.id, done: item.done ? "0" : "1" }}
                              className="ml-auto flex items-center gap-2" />
                ) : null}
                {open && writes ? (
                  <ActionForm action={removeItem} submit={`Take ${item.label} off`} tone="quiet"
                              hidden={{ taskId: id, itemId: item.id }} className="flex items-center gap-2" />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {open && writes ? (
          <ActionForm action={addItem} submit="Add item" tone="quiet" hidden={{ taskId: id }}
                      className="mt-3 flex flex-wrap items-end gap-2">
            <TextField label="New item" name="label" required maxLength={300} className="block w-72" />
          </ActionForm>
        ) : null}
      </section>

      {open && writes ? (
        <section aria-label="Close it" className="mt-8">
          <h2 className="text-base font-semibold">Close it</h2>
          {list.open > 0 ? (
            <p className="mt-1 text-sm text-ink-700">
              {list.open === 1 ? "One item is" : `${list.open} items are`} not ticked. Say why it is done anyway, or dismiss it.
            </p>
          ) : null}
          <ActionForm action={finishTask} submit="Done" hidden={{ id }} className="mt-3 space-y-3">
            <TextField label="What happened" name="outcome" maxLength={2000} />
            {list.open > 0 ? <TextField label="Why it is done with items unticked" name="overrideReason" maxLength={2000} /> : null}
          </ActionForm>
          <ActionForm action={finishTask} submit="Dismiss" tone="quiet" hidden={{ id, dismissed: "1" }} className="mt-4 space-y-3">
            <TextField label="Why it is not being done" name="outcome" maxLength={2000} />
          </ActionForm>
        </section>
      ) : null}

      {escalations.length > 0 && (
        <section aria-label="Escalations" className="mt-8">
          <h2 className="text-base font-semibold">Escalated</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {escalations.map((e) => (
              <li key={e.id}>
                <span className="text-ink-500">{formatIn(e.at, tz)}:</span> {e.rule}. Told {e.notified.join(", ") || "nobody"}
                {e.reassignedTo ? `, and handed to ${e.reassignedTo}` : ""}.
                {e.note ? <span className="block text-ink-500">{e.note}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
