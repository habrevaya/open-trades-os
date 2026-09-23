import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { workflows, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { PageHeader, Empty } from "@/components/Table";
import { EnableSwitch } from "../EnableSwitch";
import { EditForm } from "./EditForm";
import { DeleteButton } from "./DeleteButton";

export const dynamic = "force-dynamic";

const RUN_TONE: Record<string, "success" | "danger" | "warning" | "neutral" | "info"> = {
  succeeded: "success", failed: "danger", waiting: "info",
  running: "warning", skipped: "neutral", cancelled: "neutral", pending: "neutral",
};

/**
 * One automation, and what it actually did.
 *
 * The run log is the point. "Why did this customer get that text in March" is
 * the question somebody opens this screen with, and a list of workflows
 * answers it no better than not having the screen.
 */
export default async function AutomationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "workflow:read")) notFound();

  let data;
  try {
    data = await workflows.detail(ctx, { id });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const writes = can(user.actor, "workflow:write");
  const { workflow, version } = data;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <a href="/automations" className="text-sm text-ink-500 hover:underline">Automations</a>
      <div className="mt-2">
        <PageHeader
          title={workflow.name}
          action={writes ? <EnableSwitch id={workflow.id} enabled={workflow.enabled} /> : null}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-700">
        <Chip tone={workflow.enabled ? "success" : "neutral"}>
          {workflow.enabled ? "On" : "Off"}
        </Chip>
        <span>
          {workflow.triggerKind === "schedule"
            ? data.scheduleText
            : workflow.triggerKind === "dwell"
              ? data.dwellText
              : `When ${(workflow.triggerEvents ?? []).join(" or ") || "nothing"}`}
        </span>
        {version ? <span className="text-ink-500">version {version.version}</span> : null}
      </div>

      {workflow.description ? (
        <p className="mt-2 text-sm text-ink-700">{workflow.description}</p>
      ) : null}

      {data.scheduleState?.lastError ? (
        <p role="alert" className="mt-3 rounded-md border border-red-600 bg-red-tint p-3 text-sm text-red-600">
          {data.scheduleState.lastError}
        </p>
      ) : null}

      {version ? (
        <p className="mt-3 text-sm text-ink-500">
          {/*
            What a run is allowed to do, in the words the permission list
            uses. A workflow acting with the owner's permissions is the
            escalation this design exists to prevent, so the screen says
            whose it acts with.
          */}
          It may: {(version.requiredPermissions ?? []).join(", ") || "nothing that needs a permission"}
        </p>
      ) : null}

      <h2 className="mt-8 text-sm font-medium text-ink-700">What it did</h2>
      {data.runs.length === 0 ? (
        <Empty title="It has not run yet">
          {workflow.enabled
            ? "Nothing has matched it so far."
            : "It is switched off, so nothing will match it."}
        </Empty>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {data.runs.map((run) => (
            <li key={run.id} className="bg-canvas p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <Chip tone={RUN_TONE[run.status] ?? "neutral"}>{run.status}</Chip>
                {run.startedAt ? (
                  <span className="text-sm text-ink-500">
                    {formatIn(run.startedAt, user.organizationTimezone)}
                  </span>
                ) : null}
                {run.eventName ? (
                  <span className="font-mono text-xs text-ink-500">{run.eventName}</span>
                ) : null}
                {run.resumeAt ? (
                  <span className="text-sm text-ink-700">
                    waiting until {formatIn(run.resumeAt, user.organizationTimezone)}
                  </span>
                ) : null}
              </div>

              {run.error ? <p className="mt-1 text-sm text-red-600">{run.error}</p> : null}

              {run.steps.length > 0 ? (
                <ol className="mt-2 space-y-1 text-sm">
                  {run.steps.map((step) => (
                    <li key={step.index} className="flex flex-wrap items-baseline gap-2">
                      <span className="text-ink-500">{step.index + 1}.</span>
                      <span className="font-medium">{step.kind.replace(/_/g, " ")}</span>
                      <Chip tone={RUN_TONE[step.status] ?? "neutral"}>{step.status}</Chip>
                      {step.error ? <span className="text-red-600">{step.error}</span> : null}
                      {/*
                        A refused message is a successful step with a reason,
                        and that reason is the single most asked question
                        about an automation that sends texts.
                      */}
                      {step.output && step.output["refused"] ? (
                        <span className="text-ink-700">
                          not sent: {String(step.output["refused"])}
                        </span>
                      ) : null}
                      {/*
                        And a queued one is not a sent one. "send message,
                        succeeded" reads as "the text went out", and with no
                        carrier connected it did not: it is in the outbox.
                        Claiming sent for a row in a table is the one thing
                        that would make this log worthless.
                      */}
                      {step.output && step.output["queued"] && !step.output["sent"] ? (
                        <span className="text-ink-700">queued, not yet with a carrier</span>
                      ) : null}
                      {step.output && step.output["waitUntil"] ? (
                        <span className="text-ink-700">
                          until {formatIn(String(step.output["waitUntil"]), user.organizationTimezone)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {writes ? (
        <>
          <h2 className="mt-10 text-sm font-medium text-ink-700">Change it</h2>
          <p className="mt-1 text-xs text-ink-500">
            Saving publishes a new version rather than editing this one, so a
            run that already happened still says what it ran.
          </p>
          <EditForm
            id={workflow.id}
            events={await workflows.triggerEvents(ctx)}
            steps={workflows.availableSteps(ctx)}
            shapes={workflows.dwellShapes()}
            initial={{
              name: workflow.name,
              description: workflow.description,
              triggerKind: workflow.triggerKind,
              triggerEvents: workflow.triggerEvents ?? [],
              schedule: workflow.schedule,
              dwell: workflow.dwell,
              steps: (version?.steps as { kind: string; config?: Record<string, unknown> }[]) ?? [],
            }}
          />
          <div className="mt-8 border-t border-steel-200 pt-4">
            <DeleteButton id={workflow.id} name={workflow.name} />
          </div>
        </>
      ) : null}
    </div>
  );
}
