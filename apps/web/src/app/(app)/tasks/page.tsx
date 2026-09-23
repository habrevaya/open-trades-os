import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Empty, PageHeader } from "@/components/Table";
import { TASK_PRIORITY, label } from "@/lib/labels";
import { TaskActions } from "./TaskActions";

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

  const page = await tasks.list({ actor: user.actor, db: getDb() }, { view, limit: 100 });
  const writes = can(user.actor, "task:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Tasks" count={page.data.length} />

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
