import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { me } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Fact, Facts } from "@/components/Detail";
import { Empty, Table, Td, Th } from "@/components/Table";
import { formatDay, formatIn } from "@/lib/dates";
import { addContact, removeContact, setLine } from "./actions";
import { SignDocument } from "./SignDocument";

export const dynamic = "force-dynamic";

const EMPLOYMENT: Record<string, string> = {
  full_time: "Full time", part_time: "Part time", seasonal: "Seasonal", temporary: "Temporary", contractor: "Contractor",
};
const PAID: Record<string, string> = {
  hourly: "By the hour", salary: "Salary", piece_rate: "Piece rate", commission_only: "Commission only",
};

/**
 * MY RECORD
 *
 * What the office keeps about the person signed in, shown to them, on a
 * phone first: the documents waiting for their signature at the top, because
 * that is the thing to do; then their onboarding, who to ring if they are
 * hurt, and their licences with when each runs out. Their pay and their time
 * off are the two pages under this one.
 *
 * Only ever their own. The page asks for nobody by id; the services find the
 * person from the session.
 */
export default async function MyRecordPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "profile:own")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="text-xl font-semibold">My record</h1>
        <Empty title="Not part of your access">Ask the office to give your role See your own staff record.</Empty>
      </div>
    );
  }
  const record = await me.record({ actor: user.actor, db: getDb() });
  const zone = user.organizationTimezone;
  const waiting = record.documents.filter((d) => !d.signedAt);
  const signed = record.documents.filter((d) => d.signedAt);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-xl font-semibold">{record.name}</h1>
      <Facts>
        <Fact label="Role">{record.roleLabel}</Fact>
        <Fact label="Branch">{record.branchName}</Fact>
        <Fact label="Shop">{record.locationName}</Fact>
        <Fact label="Email">{record.email}</Fact>
        <Fact label="Job title">{record.employment?.jobTitle ?? null}</Fact>
        <Fact label="Started">{record.employment ? formatDay(record.employment.startedOn, zone) : null}</Fact>
        <Fact label="Employment">{record.employment ? EMPLOYMENT[record.employment.employmentType] ?? null : null}</Fact>
        <Fact label="Paid">{record.employment ? PAID[record.employment.payType] ?? null : null}</Fact>
      </Facts>
      <p className="mt-3 flex flex-wrap gap-4 text-sm">
        <a href="/me/pay" className="text-blue-600 underline underline-offset-4">My pay</a>
        {record.technicianId ? <a href="/me/expenses" className="text-blue-600 underline underline-offset-4">Money I spent</a> : null}
        {record.technicianId ? <a href="/me/time-off" className="text-blue-600 underline underline-offset-4">Time off</a> : null}
      </p>

      <section className="mt-8" aria-labelledby="to-sign">
        <h2 id="to-sign" className="text-base font-semibold">Documents to sign</h2>
        {waiting.length === 0 ? (
          <p className="mt-1 text-sm text-ink-700">Nothing is waiting for your signature.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {waiting.map((d) => <SignDocument key={d.requestId} requestId={d.requestId} title={d.title} body={d.body} />)}
          </div>
        )}
        {signed.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm">
            {signed.map((d) => (
              <li key={d.requestId} className="flex flex-wrap items-center gap-2">
                <Chip tone="success">Signed</Chip>
                <span>{d.title}</span>
                <span className="text-ink-500">
                  {formatIn(d.signedAt!, zone)}, {d.signedVia === "drawn" ? "drawn" : `typed as ${d.signerName ?? ""}`}
                </span>
                <a href={`/me/documents/${d.requestId}/pdf`} className="text-blue-600 underline underline-offset-4"
                   aria-label={`Print ${d.title} as a PDF`}>Print as PDF</a>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="onboarding">
        <h2 id="onboarding" className="text-base font-semibold">Onboarding</h2>
        {record.onboarding.lines.length === 0 ? (
          <p className="mt-1 text-sm text-ink-700">Nothing on your checklist yet. The office starts it.</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-700">{record.onboarding.progress.sentence}</p>
            <ul className="mt-2 space-y-2 text-sm">
              {record.onboarding.lines.map((line) => {
                const mine = line.doneAt !== null && line.doneByUserId === user.userId;
                return (
                  <li key={line.id} className="flex flex-wrap items-center gap-2">
                    {line.doneAt
                      ? <Chip tone="success">Done</Chip>
                      : <Chip tone={line.required ? "warning" : "neutral"}>{line.required ? "To do" : "Optional"}</Chip>}
                    <span>{line.label}</span>
                    {line.doneAt ? (
                      <span className="text-ink-500">
                        {formatIn(line.doneAt, zone)}{line.doneBy ? ` by ${line.doneBy}` : ""}{line.note ? `: ${line.note}` : ""}
                      </span>
                    ) : null}
                    {line.staffDocumentId && !line.doneAt ? (
                      <span className="text-ink-500">Done by signing it above.</span>
                    ) : !line.doneAt ? (
                      <ActionForm action={setLine} submit="Done" tone="quiet" className="inline-flex items-center gap-2"
                                  hidden={{ id: line.id, done: "true" }} />
                    ) : mine && !line.staffDocumentId ? (
                      <ActionForm action={setLine} submit="Untick" tone="quiet" className="inline-flex items-center gap-2"
                                  hidden={{ id: line.id, done: "false" }} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <section className="mt-8" aria-labelledby="contacts">
        <h2 id="contacts" className="text-base font-semibold">Who to ring if you are hurt</h2>
        {record.emergencyContacts.length === 0 ? (
          <p className="mt-1 text-sm text-amber-700">Nobody is on file. Add somebody, so the office knows who to call.</p>
        ) : (
          <ol className="mt-2 space-y-1 text-sm">
            {record.emergencyContacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                {c.relationship ? <span className="text-ink-500">{c.relationship}</span> : null}
                <span className="font-mono">{c.phone}</span>
                {c.alternatePhone ? <span className="font-mono text-ink-500">{c.alternatePhone}</span> : null}
                <ActionForm action={removeContact} submit={`Remove ${c.name}`} tone="quiet" className="inline-flex" hidden={{ id: c.id }} />
              </li>
            ))}
          </ol>
        )}
        <ActionForm action={addContact} submit="Add contact" className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField label="Their name" name="name" required maxLength={200} />
          <TextField label="Who they are to you" name="relationship" maxLength={100} placeholder="Wife, brother, friend" />
          <TextField label="Phone" name="phone" type="tel" required maxLength={40} />
          <TextField label="Other phone" name="alternatePhone" type="tel" maxLength={40} />
        </ActionForm>
      </section>

      {record.technicianId ? (
        <section className="mt-8" aria-labelledby="licences">
          <h2 id="licences" className="text-base font-semibold">Licences and certifications</h2>
          {record.certifications.length === 0 ? (
            <p className="mt-1 text-sm text-ink-700">None recorded. If you hold one, show the office the card.</p>
          ) : (
            <Table head={<><Th>Certification</Th><Th>Number</Th><Th>Runs out</Th><Th>{""}</Th></>}>
              {record.certifications.map((c) => (
                <tr key={c.id}>
                  <Td><span className="font-medium">{c.name}</span>{c.authority ? <span className="block text-xs text-ink-500">{c.authority}</span> : null}</Td>
                  <Td className="font-mono">{c.reference ?? ""}</Td>
                  <Td>{c.expiresOn ? formatDay(c.expiresOn, zone) : "Does not run out"}</Td>
                  <Td>
                    {c.current
                      ? <Chip tone="success">Current</Chip>
                      : <Chip tone="danger">{c.lapseReason === "expired" ? "Expired" : c.lapseReason === "suspended" ? "Suspended" : "Revoked"}</Chip>}
                    {c.verifiedAt ? null : <span className="ml-2 text-xs text-ink-500">The office has not seen the card yet</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {record.continuingEducation && record.continuingEducation.progress.length > 0 ? (
            <>
              <h3 className="mt-6 text-sm font-semibold">Continuing education</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {record.continuingEducation.progress.map((p) => (
                  <li key={p.certificationTypeId}>
                    <span className="font-medium">{p.name}:</span> <span className="text-ink-700">{p.progress.sentence}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
