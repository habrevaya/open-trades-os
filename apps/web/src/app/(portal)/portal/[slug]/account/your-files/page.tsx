import { getDb } from "@/lib/db";
import { files as fileRules } from "@opentradesos/core";
import { portalFiles } from "@opentradesos/api/services";
import { ActionForm } from "@/components/ActionForm";
import { requirePortalSession } from "@/lib/portal-session";
import { PortalBrand } from "../../../../PortalBrand";
import { FileInput } from "./FileInput";
import { addFile, removeFile } from "./actions";

export const dynamic = "force-dynamic";

/**
 * A SIGNED IN CUSTOMER SENDING A PHOTOGRAPH OR A PDF ABOUT THEIR JOB
 *
 * A picture of the broken unit before the visit, or the warranty card. It
 * goes with the job or with one visit still to come, the technician sees it
 * on that visit and the office on the job. The customer can take a file
 * back until somebody at the company has opened it.
 */
export default async function YourFilesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requirePortalSession(slug);
  const mine = await portalFiles.list(getDb(), { token: session.token });
  const base = `/portal/${encodeURIComponent(slug)}`;
  const company = session.organizationName;

  return (
    <PortalBrand token={session.token} logoHref={`${base}/logo`}>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{company}</p>
        <h1 className="mt-1 text-2xl font-semibold">Send us a photo or a PDF</h1>
        <a href={`${base}/account`} className="mt-2 inline-block text-sm text-ink-700 underline underline-offset-4">
          Back to your account
        </a>
      </header>

      {mine.targets.length === 0 ? (
        <p className="rounded-md border border-steel-200 bg-canvas p-5 text-sm text-ink-700">
          You have no work with {company} yet that a file can go with. Reply to any message from them instead.
        </p>
      ) : (
        <section aria-label="Send a file" className="rounded-md border border-steel-200 bg-canvas p-5">
          <p className="text-sm text-ink-700">
            A photo of the problem helps the technician come ready. A photo or a PDF, up
            to {mine.limits.maxFileMegabytes} MB, and up to {mine.limits.maxFilesPerJob} files on one job.
          </p>
          <ActionForm action={addFile.bind(null, slug)} submit="Send the file" className="mt-4 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-ink-700">What is it about?</span>
              <select name="about" required className="mt-1 block w-full rounded border border-steel-300 bg-canvas px-2 py-2 text-sm">
                {mine.targets.map((t) => (
                  <option key={`${t.jobId}:${t.visitId ?? ""}`} value={`${t.jobId}:${t.visitId ?? ""}`}>{t.label}</option>
                ))}
              </select>
            </label>
            <FileInput maxBytes={fileRules.CUSTOMER_UPLOADS.maxFileBytes} />
          </ActionForm>
        </section>
      )}

      <section aria-label="Files you sent" className="mt-6">
        <h2 className="text-base font-semibold">Files you sent</h2>
        {mine.files.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
            {mine.files.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
                <span>
                  <span className="font-medium">{file.fileName ?? "File"}</span>
                  <span className="block text-xs text-ink-500">
                    {file.jobLabel}. {file.seen ? `${company} has opened it, so it stays with the job.` : "Not opened yet."}
                  </span>
                </span>
                {file.removable && (
                  <ActionForm
                    action={removeFile.bind(null, slug)} submit="Take it back" hidden={{ id: file.id }}
                    tone="quiet" className="ml-auto"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalBrand>
  );
}
