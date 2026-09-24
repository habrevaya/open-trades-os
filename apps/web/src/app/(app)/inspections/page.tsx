import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inspections } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * THE DEFICIENCY BACKLOG
 *
 * Every fault found on an inspection and not yet put right, worst and most
 * overdue first. It is the list the compliance half of this trade runs on,
 * and until the inspection module was wired nothing could put a row on it.
 *
 * THE ORDER IS OVERDUE FIRST, THEN SEVERITY, THEN AGE, and the deadline
 * comes from the severity rather than from a field somebody fills in: a
 * safety finding is today, a failure is thirty days, wear is a hundred and
 * eighty, a recommendation has no deadline at all. Leaving that to be typed
 * is how every finding ends up with the same date and the list stops sorting
 * anything.
 *
 * EACH ROW CARRIES CORE'S OWN SENTENCE rather than a number this page
 * formats. "Open 40 days against a 30 day response" is a thing somebody can
 * act on; a red badge saying 40 is a thing they learn to ignore.
 */
export default async function InspectionsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "compliance:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Inspections" />
        <Empty title="Inspections are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const [open, programs] = await Promise.all([
    inspections.backlog(ctx, {}),
    inspections.programs(ctx),
  ]);

  const overdue = open.filter((row) => row.overdue);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Inspections" count={open.length} />

      {programs.length === 0 ? (
        <Empty title="No inspection programme yet">
          A programme is the checklist an inspection is performed against: the
          checkpoints, what a failure of each one means, and how often it comes
          round. Trade packs ship them, and a programme with no checkpoints is
          refused rather than reporting every visit as a pass.
        </Empty>
      ) : (
        <p className="mt-1 text-sm text-ink-500">
          {programs.map((program) => `${program.name} (${program.checkpointCount} checks)`).join(" · ")}
        </p>
      )}

      {overdue.length > 0 && (
        <p className="mt-6 rounded-md border border-red-600/20 bg-red-tint p-3 text-sm text-ink-900">
          {overdue.length === 1 ? "One finding is" : `${overdue.length} findings are`} past
          the deadline their severity sets.
        </p>
      )}

      {open.length === 0 ? (
        <Empty title="Nothing outstanding">
          Findings appear here as inspections are recorded, worst and most
          overdue first.
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {open.map((row) => (
            <li key={row.id} className="bg-canvas p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                {/*
                  Core's own label for the severity, not the database word.
                  "Safety" and "critical" are the same row and only one of
                  them tells a technician what to do about it today.
                */}
                <Chip tone={toneFor(row.severity)}>{label(row.severity)}</Chip>
                {row.overdue && <Chip tone="danger">Overdue</Chip>}
                <span className="font-medium text-ink-900">{row.description}</span>
                <span className="text-sm text-ink-700">{row.customerName}</span>
                <span className="text-xs text-ink-500">{row.address}</span>
              </div>

              {/*
                The sentence, not the number. "Open 40 days against a 30 day
                response" is actionable; a badge saying 40 is decoration.
              */}
              <p className="mt-1 text-sm text-ink-700">{row.statement}</p>

              {row.recommendedAction && (
                <p className="mt-1 text-sm text-ink-900">{row.recommendedAction}</p>
              )}

              <p className="mt-1 text-xs text-ink-500">
                Found {row.foundOn}
                {row.correctByOn ? ` · correct by ${row.correctByOn}` : " · no deadline"}
                {` · ${row.status}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const label = (severity: string): string =>
  severity === "safety" ? "Safety"
  : severity === "failure" ? "Failed"
  : severity === "wear" ? "Wearing out"
  : "Recommendation";

const toneFor = (severity: string) =>
  severity === "safety" ? "danger" as const
  : severity === "failure" ? "warning" as const
  : "neutral" as const;
