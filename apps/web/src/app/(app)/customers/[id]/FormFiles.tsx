import { files, jobs, type ServiceContext } from "@opentradesos/api/services";
import { can, work } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { moveFormFile } from "./form-file-actions";

/**
 * WHAT CAME WITH A LEAD FORM
 *
 * The photographs and PDFs somebody sent with one of the company's hosted
 * forms, kept on the customer the form matched or made, or on one of their
 * jobs once somebody moved it there. Said plainly where they came from:
 * whoever filled the form in gave this customer's phone number or email,
 * which is not the same as the customer signing in, so the office reads them
 * as what a lead sent. Only for somebody who may read documents, and absent
 * when there are none.
 *
 * On the customer, each file offers "Put it on the job" for somebody who may
 * change jobs: one of this customer's jobs, the file moved and still private
 * (`POST /v1/attachments/{id}/job`).
 */
export async function FormFiles({ ctx, customerId, jobId, timezone }: {
  ctx: ServiceContext;
  customerId: string;
  /** On a job's page: the files moved onto this job. */
  jobId?: string;
  timezone: string;
}) {
  if (!can(ctx.actor, "document:read")) return null;
  const sent = (await files.attachmentsFor(ctx, jobId
    ? { entityType: "job", entityId: jobId }
    : { entityType: "customer", entityId: customerId }))
    .filter((file) => file.kind === "form_file");
  if (sent.length === 0) return null;

  const moves = !jobId && can(ctx.actor, "job:write") && can(ctx.actor, "job:read");
  const theirJobs = moves
    ? (await jobs.list(ctx, {
        customerId, limit: 50,
        status: ["lead", "estimating", "scheduled", "in_progress", "on_hold", "completed", "invoiced", "paid"],
      })).data
    : [];

  return (
    <section aria-label="Sent with a lead form" className="mt-10">
      <h2 className="text-base font-semibold">Sent with a lead form</h2>
      <p className="mt-1 text-sm text-ink-700">
        Photos and PDFs sent with one of your lead forms by somebody who gave this customer&apos;s phone number or email.
        Only you see them{jobId ? "" : ", here or on the job you put them on"}. They are never shown to the customer or on
        the technician&apos;s phone.
      </p>
      <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
        {sent.map((file) => (
          <li key={file.id} data-testid="form-file" className="bg-canvas p-3 text-sm">
            <a href={`/files/${file.storageKey}`} className="font-medium underline underline-offset-4">
              {file.fileName ?? "File"}
            </a>
            <span className="block text-xs text-ink-500">
              Sent {formatIn(file.createdAt.toISOString(), timezone, { dateStyle: "medium" })}
            </span>
            {moves && theirJobs.length > 0 ? (
              <ActionForm action={moveFormFile} submit="Put it on the job" tone="quiet"
                          hidden={{ id: file.id, customerId }} className="mt-2 flex flex-wrap items-center gap-2">
                <select name="jobId" aria-label={`Job for ${file.fileName ?? "this file"}`}
                        className="h-9 rounded border border-steel-300 bg-canvas px-2 text-sm">
                  {theirJobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      Job {work.documentNumber(j.numberPrefix ?? null, j.number)}{j.summary ? `, ${j.summary}` : ""}
                    </option>
                  ))}
                </select>
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
