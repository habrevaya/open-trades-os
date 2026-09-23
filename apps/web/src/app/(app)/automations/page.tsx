import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { workflows } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Empty, PageHeader } from "@/components/Table";
import { EnableSwitch } from "./EnableSwitch";

export const dynamic = "force-dynamic";

/**
 * AUTOMATIONS
 *
 * The engine has been running for a while and the only way to make a workflow
 * was to insert rows by hand. Worse, the only way to STOP one was the same.
 * An automation sending the wrong thing to customers with no button to stop
 * it is a worse failure than the automation not existing.
 *
 * So this screen is what exists, what it did, and make it stop. Not a visual
 * builder: a canvas of boxes and arrows is the thing everybody pictures and
 * the thing almost nobody finishes, and it would not answer the question this
 * screen is actually opened for, which is "why did that customer get a text".
 */
const RUN_TONE: Record<string, "success" | "danger" | "warning" | "neutral" | "info"> = {
  succeeded: "success",
  failed: "danger",
  waiting: "info",
  running: "warning",
  skipped: "neutral",
  cancelled: "neutral",
  pending: "neutral",
};

export default async function AutomationsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "workflow:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Automations" />
        <Empty title="Automations are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const list = await workflows.list(ctx);
  const writes = can(user.actor, "workflow:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Automations"
        count={list.length}
        action={writes ? (
          <a
            href="/automations/new"
            className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white hover:bg-ink-700"
          >
            New automation
          </a>
        ) : null}
      />

      <p className="mt-2 text-sm text-ink-700">
        An automation runs with the permissions its own version declared, not
        with yours and not with the owner&apos;s.
      </p>

      {list.length === 0 ? (
        <Empty title="Nothing is automated yet">
          The useful first one is usually the estimate nobody answered: wait
          three days, then raise a task for whoever sent it.
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {list.map((flow) => (
            <li key={flow.id} className="bg-canvas p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <a href={`/automations/${flow.id}`} className="font-medium hover:underline">
                    {flow.name}
                  </a>
                  <Chip tone={flow.enabled ? "success" : "neutral"}>
                    {flow.enabled ? "On" : "Off"}
                  </Chip>
                  {flow.version === null && <Chip tone="warning">Nothing published</Chip>}
                </div>
                {writes ? <EnableSwitch id={flow.id} enabled={flow.enabled} /> : null}
              </div>

              <p className="mt-1 text-sm text-ink-700">
                {flow.triggerKind === "schedule"
                  ? flow.scheduleText
                  : `When ${flow.triggerEvents.join(" or ") || "nothing, which never fires"}`}
              </p>

              {/*
                Said out loud rather than left as a workflow that quietly
                never runs. An expression nothing can read is the automation
                failure nobody notices until a customer does.
              */}
              {flow.scheduleError ? (
                <p className="mt-1 text-sm text-red-600">{flow.scheduleError}</p>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-500">
                <span>{flow.steps.map((s) => s.kind.replace(/_/g, " ")).join(", ") || "no steps"}</span>
                {flow.nextRunAt && flow.enabled ? (
                  <span>Next {formatIn(flow.nextRunAt, user.organizationTimezone)}</span>
                ) : null}
                {flow.recent.length > 0 ? (
                  <span className="flex items-center gap-1">
                    {/*
                      The last five, oldest on the right. A row of green and
                      one red is the fastest way to see that something
                      started failing, and it needs no chart.
                    */}
                    {flow.recent.map((run, i) => (
                      <Chip key={i} tone={RUN_TONE[run.status] ?? "neutral"}>{run.status}</Chip>
                    ))}
                  </span>
                ) : (
                  <span>never run</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
