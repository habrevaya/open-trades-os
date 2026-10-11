import { Chip } from "@opentradesos/ui";

/**
 * THE STAGES A CONNECTED APPLICATION SET FOR THIS KIND OF WORK
 *
 * Drawn only when the job's type has a workflow in force (M28): the stages in
 * order, the one the job is at, and what each waits on before the job may
 * leave it, ticked or not. The same gates the service checks when the job is
 * moved, so a refusal is never a surprise to somebody who read this first.
 * Written out rather than imported from the service, so a case the service
 * cannot produce today can still be drawn in a test.
 */
export interface StagesData {
  workflow: { name: string; appName: string; version: number } | null;
  stages: Array<{
    key: string;
    name: string;
    current: boolean;
    gates: Array<{ kind: "checklist" | "field"; label: string; met: boolean | null }>;
  }>;
}

export function Stages({ data }: { data: StagesData }) {
  if (!data.workflow || data.stages.length === 0) return null;
  const here = data.stages.findIndex((stage) => stage.current);
  return (
    <section aria-labelledby="stages-heading" className="mt-6 rounded-md border border-steel-200 p-4">
      <h2 id="stages-heading" className="text-sm font-medium text-ink-900">Stages</h2>
      <p className="mt-0.5 text-xs text-ink-500">
        {data.workflow.name}, set by {data.workflow.appName}. A job only moves on once what a stage waits for is done.
      </p>
      <ol className="mt-3 space-y-2">
        {data.stages.map((stage, index) => (
          <li key={stage.key} className="text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={stage.current ? "font-semibold text-ink-900" : index < here ? "text-ink-500" : "text-ink-700"}>
                {index + 1}. {stage.name}
              </span>
              {stage.current ? <Chip tone="info">Here now</Chip> : index < here ? <Chip tone="neutral">Done</Chip> : null}
            </div>
            {stage.gates.length > 0 ? (
              <ul className="ml-5 mt-1 space-y-0.5 text-xs">
                {stage.gates.map((gate) => (
                  <li key={`${gate.kind}:${gate.label}`} className={gate.met === true ? "text-green-700" : "text-ink-700"}>
                    {gate.met === true ? "Done: " : gate.met === false ? "Waiting on: " : "Not shown to you: "}
                    {gate.kind === "checklist" ? `"${gate.label}" ticked on a visit` : `"${gate.label}" filled in`}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
