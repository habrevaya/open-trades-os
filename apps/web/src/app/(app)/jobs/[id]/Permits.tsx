import { permitInspections, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { Table, Th, Td } from "@/components/Table";
import { filePermit, recordInspection, removeInspection } from "./permit-actions";

const RESULT = { passed: "Passed", failed: "Failed" } as const;
const WHOSE = { our_work: "Our work", outside_our_work: "Not our work" } as const;

/** Where the job stands in the first time pass rate, in words. */
const VERDICT = {
  passed: "Every inspection so far passed the first time.",
  failed: "An inspector failed our work on this job, so it is not a first time pass.",
  excluded: "An inspector failed it only for somebody else's work, so it is left out of the first time pass rate.",
} as const;

/**
 * PERMITS AND THE CITY'S INSPECTIONS
 *
 * The permits filed on this job and every visit the inspector made under
 * each: the day, the stage, passed or failed, and on a fail what they wrote
 * and whose work it was. That last answer is what lets the first time pass
 * rate leave out a fail that was another trade's, so it is asked on every
 * fail and never guessed from the words.
 *
 * Reading needs the job and `document:read`; filing a permit needs
 * `document:write`; recording or taking off an inspection needs `job:write`.
 */
export async function Permits({ ctx, jobId, today }: { ctx: ServiceContext; jobId: string; today: string }) {
  if (!can(ctx.actor, "document:read")) return null;
  const data = await permitInspections.forJob(ctx, { id: jobId });
  const files = can(ctx.actor, "document:write");
  const records = can(ctx.actor, "job:write");
  if (data.permits.length === 0 && !files) return null;
  const permits = data.permits.filter((p) => p.state !== "withdrawn");

  return (
    <section aria-labelledby="permits" className="mt-10">
      <h2 id="permits" className="text-base font-semibold">Permits and inspections</h2>
      <p className="mt-1 text-sm text-ink-700">
        Each visit the inspector made, and what they said. On a fail, say whose work it was: a fail for another
        trade or a site that was not ready is left out of your first time pass rate.
      </p>
      {data.verdict && <p className="mt-2 text-sm font-medium">{VERDICT[data.verdict]}</p>}

      {data.permits.length === 0 && <p className="mt-2 text-sm text-ink-500">No permit on this job yet.</p>}

      {data.permits.map((permit) => (
        <div key={permit.id} className="mt-5">
          <h3 className="text-sm font-semibold">
            {permit.name}
            {permit.reference && <span className="font-normal text-ink-500">, number {permit.reference}</span>}
            {permit.issuerName && <span className="font-normal text-ink-500">, from {permit.issuerName}</span>}
            {permit.state !== "active" && <Chip className="ml-2">{permit.state === "withdrawn" ? "Withdrawn" : "Renewed"}</Chip>}
          </h3>
          {permit.inspections.length === 0 ? (
            <p className="mt-1 text-sm text-ink-500">No inspection recorded yet.</p>
          ) : (
            <Table label={`Inspections under ${permit.name}`} head={<>
              <Th>Day</Th><Th>Stage</Th><Th>Result</Th><Th>What the inspector found</Th><Th>Inspector</Th>{records && <Th />}
            </>}>
              {permit.inspections.map((inspection) => (
                <tr key={inspection.id}>
                  <Td>{inspection.inspectedOn}</Td>
                  <Td>{inspection.stage ?? ""}</Td>
                  <Td>
                    <Chip tone={inspection.result === "passed" ? "success" : "danger"}>{RESULT[inspection.result]}</Chip>
                    {inspection.failureScope && <span className="ml-2 text-xs text-ink-700">{WHOSE[inspection.failureScope]}</span>}
                  </Td>
                  <Td>{inspection.findings ?? ""}</Td>
                  <Td>{inspection.inspectorName ?? ""}</Td>
                  {records && (
                    <Td>
                      <ActionForm action={removeInspection} submit="Take off" tone="quiet" className=""
                                  hidden={{ jobId, inspectionId: inspection.id }} />
                    </Td>
                  )}
                </tr>
              ))}
            </Table>
          )}
        </div>
      ))}

      {records && permits.length > 0 && (
        <ActionForm action={recordInspection} submit="Record the inspection" hidden={{ jobId }}
                    className="mt-5 grid gap-3 rounded-md border border-steel-200 p-4 sm:grid-cols-2">
          <h3 className="text-sm font-semibold sm:col-span-2">Record an inspection</h3>
          <Select label="Permit" name="permitId"
                  options={permits.map((p) => ({ value: p.id, label: p.reference ? `${p.name} (${p.reference})` : p.name }))} />
          <TextField label="Day the inspector came" name="inspectedOn" type="date" required max={today} defaultValue={today} />
          <TextField label="Stage" name="stage" placeholder="Rough in, Final" />
          <Select label="Result" name="result" options={[{ value: "passed", label: "Passed" }, { value: "failed", label: "Failed" }]} />
          <Select label="If it failed, whose work was it?" name="failureScope" options={[
            { value: "", label: "It passed" },
            { value: "our_work", label: "Our work" },
            { value: "outside_our_work", label: "Not our work: another trade, the site or the customer" },
          ]} />
          <TextField label="Inspector" name="inspectorName" />
          <div className="sm:col-span-2">
            <TextArea label="What the inspector found" name="findings" rows={2} />
          </div>
        </ActionForm>
      )}

      {files && (
        <ActionForm action={filePermit} submit="File the permit" hidden={{ jobId }}
                    className="mt-5 grid gap-3 rounded-md border border-steel-200 p-4 sm:grid-cols-2">
          <h3 className="text-sm font-semibold sm:col-span-2">File a permit on this job</h3>
          <TextField label="What it is" name="name" required placeholder="Electrical permit" />
          <TextField label="Permit number" name="reference" />
          <TextField label="Issued by" name="issuerName" placeholder="City of Austin" />
          <TextField label="Issued on" name="issuedOn" type="date" />
          <TextField label="Runs out on" name="expiresOn" type="date" />
        </ActionForm>
      )}
    </section>
  );
}
