import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { retention } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { act } from "./actions";

export const dynamic = "force-dynamic";

const HOLDABLE = [
  { value: "incident_report", label: "Incident report" },
  { value: "safety_meeting", label: "Toolbox talk" },
  { value: "service_report", label: "Service report" },
  { value: "inspection", label: "Inspection" },
  { value: "call_recording", label: "Call recording" },
];

const STATE = { due: "Goes on the next purge", held: "On hold", kept: "Kept", not_yet: "Not yet", no_clock: "Kept" } as const;

/**
 * KEEPING RECORDS, AND LETTING THEM GO
 *
 * The retention rules the trade pack seeded, each read back as a sentence,
 * with what a purge would remove under it today. Every rule arrives with
 * purging OFF: nothing is ever removed until somebody here reads the preview
 * and turns it on. A record somebody may still ask for (a claim, a dispute,
 * an inspector's letter) is put on hold and kept whatever its age. Every
 * record a purge removes leaves a line in the audit log.
 */
export default async function RetentionPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "compliance:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Keeping records" />
        <Empty title="Not shown to your role">Retention rules need the compliance permission.</Empty>
      </div>
    );
  }

  const [preview, holds, runs] = await Promise.all([
    retention.preview(ctx, { sample: 10 }),
    retention.listHolds(ctx),
    retention.listRuns(ctx, { limit: 10 }),
  ]);
  const inactive = (await retention.listPolicies(ctx)).filter((p) => !p.active);
  const writes = can(user.actor, "compliance:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Keeping records" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        How long each kind of record is kept, from when, and what a purge would remove today. These rules
        come from your trade pack and say what it was written to, not what the law in your state requires:
        check each period against your own obligations before you turn purging on.
      </p>

      {preview.length === 0 ? (
        <Empty title="No retention rules">Your trade pack declared none, so nothing is ever purged.</Empty>
      ) : (
        <div className="mt-6 space-y-4">
          {preview.map((row) => (
            <section key={row.policy.id} className="rounded-md border border-steel-200 bg-canvas p-4"
                     aria-label={`Rule: ${row.policy.name}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium text-ink-900">{row.policy.name}</h2>
                  <p className="text-sm text-ink-700">{row.policy.sentence}</p>
                  {row.policy.basis ? <p className="mt-0.5 text-xs text-ink-500">{row.policy.basis}</p> : null}
                  {row.policy.entityKind && row.policy.kindRule ? (
                    <p className="mt-0.5 text-xs text-ink-500">Only kind "{row.policy.entityKind}". {row.policy.kindRule}</p>
                  ) : null}
                </div>
                <Chip tone={row.policy.purgeAllowed ? "warning" : "neutral"}>
                  {row.policy.purgeAllowed ? "Purging on" : "Purging off"}
                </Chip>
              </div>
              <p className="mt-2 text-sm font-medium">{row.summary}</p>
              {row.policy.actsOn ? (
                <p className="mt-1 text-xs text-ink-500">
                  {row.counts.due} due, {row.counts.held} on hold, {row.counts.notYet} not yet, {row.counts.kept} kept for another reason
                </p>
              ) : null}
              {row.records.length > 0 ? (
                <ul className="mt-2 space-y-0.5 text-sm">
                  {row.records.map((record) => (
                    <li key={record.id} className="flex flex-wrap items-center gap-x-2">
                      <span><span className="font-medium">{STATE[record.state]}:</span> {record.label}</span>
                      <span className="text-ink-500">{record.why}</span>
                      {writes && record.state === "due" ? (
                        <ActionForm action={act} className="flex items-center gap-2" tone="quiet" submit="Keep it"
                                    hidden={{ op: "hold", entityType: record.entityType, entityId: record.id }}>
                          <input name="reason" required placeholder="Why it is kept" aria-label={`Why ${record.label} is kept`}
                                 className="h-8 w-48 rounded border border-steel-300 px-2 text-sm" />
                        </ActionForm>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {writes && row.policy.actsOn ? (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <ActionForm action={act} className="" tone={row.policy.purgeAllowed ? "quiet" : "danger"}
                              submit={row.policy.purgeAllowed ? "Turn purging off" : "Turn purging on"}
                              hidden={{ op: row.policy.purgeAllowed ? "purge-off" : "purge-on", id: row.policy.id }} />
                  <ActionForm action={act} className="flex items-end gap-2" tone="quiet" submit="Change the period"
                              hidden={{ op: "months", id: row.policy.id }}>
                    <TextField label="Months" name="retainMonths" type="number" min={1} max={1200}
                               defaultValue={String(row.policy.retainMonths)} className="block w-28" />
                  </ActionForm>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
      {inactive.length > 0 ? (
        <p className="mt-4 text-sm text-ink-500">Switched off and acting on nothing: {inactive.map((p) => p.name).join(", ")}.</p>
      ) : null}

      <h2 className="mt-10 text-base font-semibold">On hold</h2>
      {holds.length === 0 ? <p className="mt-1 text-sm text-ink-500">Nothing is on hold.</p> : (
        <Table label="Holds" head={<><Th>Record</Th><Th>Why</Th><Th>Since</Th><Th>{""}</Th></>}>
          {holds.map((hold) => (
            <tr key={hold.id}>
              <Td><span className="text-sm">{HOLDABLE.find((h) => h.value === hold.entityType)?.label ?? hold.entityType}</span>
                <span className="block font-mono text-xs text-ink-500">{hold.entityId}</span></Td>
              <Td>{hold.reason}</Td>
              <Td className="whitespace-nowrap">{formatIn(hold.placedAt, zone)}</Td>
              <Td>{writes ? <ActionForm action={act} className="" tone="quiet" submit="Release" hidden={{ op: "release", id: hold.id }} /> : null}</Td>
            </tr>
          ))}
        </Table>
      )}
      {writes ? (
        <ActionForm action={act} submit="Put on hold" hidden={{ op: "hold" }}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Select label="Kind of record" name="entityType" options={HOLDABLE} />
            <TextField label="Its id" name="entityId" required placeholder="From the record's page or the preview" />
            <TextField label="Why it is kept" name="reason" required placeholder="The Smith claim" />
          </div>
        </ActionForm>
      ) : null}

      <h2 className="mt-10 text-base font-semibold">Purges</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        The worker runs one a day for any rule with purging on. Each record it removes has its own line in the
        audit log naming the rule and the day it became due.
      </p>
      {writes ? <ActionForm action={act} submit="Purge now" tone="danger" hidden={{ op: "run" }} /> : null}
      {runs.length === 0 ? <p className="mt-2 text-sm text-ink-500">None yet.</p> : (
        <Table label="Purges" head={<><Th>When</Th><Th>By</Th><Th>Removed</Th><Th>On hold</Th><Th>Could not</Th></>}>
          {runs.map((run) => (
            <tr key={run.id}>
              <Td className="whitespace-nowrap">{formatIn(run.startedAt, zone)}</Td>
              <Td>{run.trigger === "worker" ? "The daily pass" : "Somebody here"}</Td>
              <Td>{run.purged}</Td>
              <Td>{run.held}</Td>
              <Td>
                {run.failed}
                {run.failures.map((failure) => (
                  <span key={failure.entityId} className="block text-xs text-red-600">{failure.reason}</span>
                ))}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
