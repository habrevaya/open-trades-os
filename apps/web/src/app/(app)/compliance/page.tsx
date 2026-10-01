import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { compliance } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "./ActionForm";
import { Counts, Documents, Filings } from "./ComplianceView";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";

/** What a filing can move to from where it is. */
const NEXT: Record<string, { to: string; label: string; ask?: string }[]> = {
  due: [{ to: "prepared", label: "Prepared" }, { to: "submitted", label: "Submitted", ask: "What was filed" }, { to: "waived", label: "Waived", ask: "Why" }],
  prepared: [{ to: "submitted", label: "Submitted", ask: "What was filed" }, { to: "waived", label: "Waived", ask: "Why" }],
  submitted: [{ to: "acknowledged", label: "Acknowledged", ask: "Their reference" }, { to: "rejected", label: "Rejected", ask: "Why" }],
  resubmitted: [{ to: "acknowledged", label: "Acknowledged", ask: "Their reference" }, { to: "rejected", label: "Rejected", ask: "Why" }],
};

/**
 * COMPLIANCE
 *
 * The documents the company holds (licences, insurance, bonds, permits) and
 * when each runs out, the ones marked needed for work that already have, and
 * the filing calendar its trade pack declares. Renewals and filings also go
 * into the task queue; this is where they are seen together.
 */
export default async function CompliancePage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const docs = can(user.actor, "document:read");
  const filings = can(user.actor, "compliance:read");

  if (!docs && !filings) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Compliance" />
        <Empty title="Not shown to your role">Compliance documents and filings need their own permissions.</Empty>
      </div>
    );
  }

  const [summary, documents, blocking, submissions, declared] = await Promise.all([
    docs ? compliance.handlers.getComplianceSummary(ctx) : null,
    docs ? compliance.handlers.listComplianceDocuments(ctx, {}) : null,
    docs ? compliance.handlers.listWorkBlockingDocuments(ctx) : null,
    filings ? compliance.handlers.listRegulatorySubmissions(ctx, {}) : null,
    filings ? compliance.handlers.listDeclaredSubmissions(ctx) : null,
  ]);
  const writesDocs = can(user.actor, "document:write");
  const writesFilings = can(user.actor, "compliance:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Compliance" />

      {summary && <Counts summary={summary} />}

      {blocking && blocking.subjects.length > 0 && (
        <section className="mt-6 rounded-md border border-red-600/20 bg-red-tint p-4 text-sm">
          <h2 className="font-semibold text-red-600">Lapsed and marked as needed for work</h2>
          <ul className="mt-2 space-y-1">
            {blocking.subjects.flatMap((s) => s.documents).map((d) => (
              <li key={d.id}><span className="font-medium">{d.name}</span>: {d.statement}</li>
            ))}
          </ul>
        </section>
      )}

      {documents && (
        <>
          <h2 className="mt-8 text-base font-semibold">Documents on file</h2>
          <Documents
            rows={documents.documents}
            controls={writesDocs ? (d) => (
              <div className="flex flex-wrap gap-2">
                <ActionForm op="renew" label="Renew" quiet hidden={{ id: d.id, kind: d.kind, name: d.name, requiredForWork: String(d.requiredForWork) }}>
                  <input name="reference" placeholder="New number" className={input} />
                  <input name="expiresOn" type="date" className={input} />
                </ActionForm>
                <ActionForm op="withdraw" label="Withdraw" quiet hidden={{ id: d.id }}>
                  <input name="reason" required placeholder="Why" className={input} />
                </ActionForm>
              </div>
            ) : undefined}
          />
          {writesDocs && (
            <ActionForm op="register" label="Put on file" className="mt-3 flex flex-wrap items-end gap-2">
              <input name="kind" required placeholder="Kind, e.g. liability_insurance" className={input} />
              <input name="name" required placeholder="General liability policy" className={input} />
              <input name="reference" placeholder="Number" className={input} />
              <input name="issuerName" placeholder="Issued by" className={input} />
              <input name="expiresOn" type="date" className={input} />
              <label className="flex h-8 items-center gap-1 text-sm"><input type="checkbox" name="requiredForWork" /> Needed for work</label>
            </ActionForm>
          )}
        </>
      )}

      {submissions && (
        <>
          <h2 className="mt-8 text-base font-semibold">Filings</h2>
          <Filings
            rows={submissions.submissions}
            controls={writesFilings ? (s) => (
              <div className="flex flex-wrap gap-2">
                {(NEXT[s.state] ?? []).map((n) => (
                  <ActionForm key={n.to} op="advance" label={n.label} quiet hidden={{ id: s.id, to: n.to }}>
                    {n.ask && <input name="said" required placeholder={n.ask} className={input} />}
                  </ActionForm>
                ))}
                {s.state === "rejected" && <ActionForm op="resubmit" label="File again" quiet hidden={{ id: s.id }} />}
              </div>
            ) : undefined}
          />
          {writesFilings && declared && declared.submissions.length > 0 && (
            <ActionForm op="open" label="Open a filing" className="mt-3 flex flex-wrap items-end gap-2">
              <select name="kind" className={input}>
                {declared.submissions.map((d) => <option key={d.kind} value={d.kind}>{d.label} ({d.cadence})</option>)}
              </select>
              <label className="grid gap-1 text-xs text-ink-500">Due<input name="dueOn" type="date" required className={input} /></label>
              <label className="grid gap-1 text-xs text-ink-500">Period from<input name="periodStart" type="date" className={input} /></label>
              <label className="grid gap-1 text-xs text-ink-500">to<input name="periodEnd" type="date" className={input} /></label>
            </ActionForm>
          )}
        </>
      )}
    </div>
  );
}
