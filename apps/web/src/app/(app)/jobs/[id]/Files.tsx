import { files, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { shareJobPhoto, uploadJobFile } from "./actions";

/**
 * THE JOB'S FILES, AND WHICH THE CUSTOMER MAY SEE
 *
 * A permit, a signed work order, a manufacturer's sheet: documents on the job
 * or on one of its visits. Every file is private until somebody marks it, with
 * the same switch the photographs use, and a marked one shows in the
 * customer's account under their documents, read only. Marking needs
 * `servicereport:publish`, the decision of showing a customer what was
 * recorded; adding a file needs `document:write`.
 */
export async function JobFiles({ ctx, jobId, visitIds, timezone }: {
  ctx: ServiceContext;
  jobId: string;
  visitIds: string[];
  timezone: string;
}) {
  if (!can(ctx.actor, "document:read")) return null;
  const [onJob, ...onVisits] = await Promise.all([
    files.attachmentsFor(ctx, { entityType: "job", entityId: jobId }),
    ...visitIds.map((id) => files.attachmentsFor(ctx, { entityType: "visit", entityId: id })),
  ]);
  const all = [...onJob, ...onVisits.flat()];
  const documents = all.filter((f) => f.kind === "document");
  /** What the customer sent from their sign in, opened through a route that records the office has seen it. */
  const fromCustomer = all.filter((f) => f.kind === "customer_file");
  const shares = can(ctx.actor, "servicereport:publish");
  const adds = can(ctx.actor, "document:write");
  if (documents.length === 0 && fromCustomer.length === 0 && !adds) return null;
  return (
    <section aria-label="Files" className="mt-10">
      <h2 className="text-base font-semibold">Files</h2>
      <p className="mt-1 text-sm text-ink-700">
        Only you see a file until you show it to the customer. One you show appears in their account under their
        documents, and they cannot change it.
      </p>
      {documents.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No files yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {documents.map((file) => (
            <li key={file.id} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
              <span>
                <a href={`/files/${file.storageKey}`} className="font-medium underline underline-offset-4">
                  {file.fileName ?? "File"}
                </a>
                <span className="block text-xs text-ink-500">
                  Added {formatIn(file.createdAt.toISOString(), timezone, { dateStyle: "medium" })}
                  {file.sharedWithCustomerAt ? ", shown to the customer" : ", private"}
                </span>
              </span>
              {shares && (
                <ActionForm
                  action={shareJobPhoto}
                  submit={file.sharedWithCustomerAt ? "Stop showing the customer" : "Show the customer"}
                  hidden={{ jobId, attachmentId: file.id, shared: file.sharedWithCustomerAt ? "no" : "yes" }}
                  tone="quiet" className="ml-auto"
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {fromCustomer.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-semibold">From the customer</h3>
          <p className="mt-1 text-sm text-ink-700">
            Sent from their account. They can take a file back until somebody here opens it.
          </p>
          <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
            {fromCustomer.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
                <span>
                  <a href={`/jobs/${jobId}/customer-files/${file.id}`} className="font-medium underline underline-offset-4">
                    {file.fileName ?? "File"}
                  </a>
                  <span className="block text-xs text-ink-500">
                    Sent {formatIn(file.createdAt.toISOString(), timezone, { dateStyle: "medium" })}
                    {file.seenAt ? ", opened" : ", not opened yet"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {adds && (
        <ActionForm action={uploadJobFile} submit="Add the file" hidden={{ jobId }} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-sm font-medium text-ink-700">A PDF or a photo</span>
            <input type="file" name="file" accept="application/pdf,image/*" required className="mt-1 block text-sm" />
          </label>
        </ActionForm>
      )}
    </section>
  );
}
