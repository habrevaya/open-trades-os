import { files, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { formatIn } from "@/lib/dates";

/**
 * WHAT CAME WITH A LEAD FORM
 *
 * The photographs and PDFs somebody sent with one of the company's hosted
 * forms, kept on the customer the form matched or made. Said plainly where
 * they came from: whoever filled the form in gave this customer's phone
 * number or email, which is not the same as the customer signing in, so the
 * office reads them as what a lead sent. Only for somebody who may read
 * documents, and absent when there are none.
 */
export async function FormFiles({ ctx, customerId, timezone }: {
  ctx: ServiceContext; customerId: string; timezone: string;
}) {
  if (!can(ctx.actor, "document:read")) return null;
  const sent = (await files.attachmentsFor(ctx, { entityType: "customer", entityId: customerId }))
    .filter((file) => file.kind === "form_file");
  if (sent.length === 0) return null;
  return (
    <section aria-label="Sent with a lead form" className="mt-10">
      <h2 className="text-base font-semibold">Sent with a lead form</h2>
      <p className="mt-1 text-sm text-ink-700">
        Photos and PDFs sent with one of your lead forms by somebody who gave this customer&apos;s phone number or email.
        Only you see them.
      </p>
      <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
        {sent.map((file) => (
          <li key={file.id} className="bg-canvas p-3 text-sm">
            <a href={`/files/${file.storageKey}`} className="font-medium underline underline-offset-4">
              {file.fileName ?? "File"}
            </a>
            <span className="block text-xs text-ink-500">
              Sent {formatIn(file.createdAt.toISOString(), timezone, { dateStyle: "medium" })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
