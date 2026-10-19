import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { me, staffNotices } from "@opentradesos/api/services";
import { can, time } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Fact, Facts } from "@/components/Detail";
import { Empty, Table, Td, Th } from "@/components/Table";
import { formatDay, formatIn } from "@/lib/dates";
import {
  addContact, saveOwnContact, logCeHours, removeContact, saveNoticeSwitches, setLine, turnOffTexts, turnOnTexts, withdrawCeHours,
} from "./actions";
import { SignDocument } from "./SignDocument";
import { OwnContactChanges } from "@/components/OwnContactChanges";

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
  const told = await staffNotices.settings({ actor: user.actor, db: getDb() });
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

      <section className="mt-8" aria-labelledby="reach">
        <h2 id="reach" className="text-base font-semibold">Your phone and address</h2>
        <p className="mt-1 text-sm text-ink-700">
          Keep these right yourself, so the office can reach you and mail you what you need. When you change
          them, the office sees what changed and when. Leave a box empty to take it off.
        </p>
        <ActionForm action={saveOwnContact} submit="Save" className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField label="Your phone number" name="phone" type="tel" maxLength={40}
                     defaultValue={record.ownContact.contact?.phone ?? ""} placeholder="(512) 555-0143" className="block sm:col-span-2" />
          <TextField label="Street" name="addressLine1" maxLength={120} defaultValue={record.ownContact.contact?.addressLine1 ?? ""} />
          <TextField label="Apartment or unit (if any)" name="addressLine2" maxLength={120} defaultValue={record.ownContact.contact?.addressLine2 ?? ""} />
          <TextField label="Town" name="city" maxLength={100} defaultValue={record.ownContact.contact?.city ?? ""} />
          <TextField label="State (two letters)" name="state" maxLength={2} defaultValue={record.ownContact.contact?.state ?? ""} placeholder="TX" />
          <TextField label="ZIP code" name="postalCode" maxLength={10} inputMode="numeric" defaultValue={record.ownContact.contact?.postalCode ?? ""} />
        </ActionForm>
        <OwnContactChanges record={record.ownContact} timezone={zone} />
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

      <NoticeSettings told={told} zone={zone} />

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
          {record.skills.length > 0 ? (
            <>
              <h3 className="mt-6 text-sm font-semibold">Skills with a last day</h3>
              <ul className="mt-2 space-y-1 text-sm" aria-label="Skills with a last day">
                {record.skills.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{s.skill}</span>
                    {s.expiry.state === "expired" ? <Chip tone="danger">Ran out</Chip>
                      : s.expiry.state === "expiring" ? <Chip tone="warning">Runs out soon</Chip>
                        : <Chip tone="success">Current</Chip>}
                    <span className="text-ink-700">{s.expiry.sentence}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {record.continuingEducation && record.continuingEducation.progress.length > 0 ? (
            <>
              <h3 className="mt-6 text-sm font-semibold">Continuing education</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {record.continuingEducation.progress.map((p) => (
                  <li key={p.certificationTypeId}>
                    <span className="font-medium">{p.name}:</span> <span className="text-ink-700">{p.progress.sentence}</span>
                    {p.pendingHours !== "0" ? <span className="text-ink-500"> {p.pendingHours} more hours wait for the office.</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {record.continuingEducation && record.continuingEducation.entries.some((e) => e.selfLogged) ? (
            <ul className="mt-3 space-y-2 text-sm" aria-label="Hours you logged">
              {record.continuingEducation.entries.filter((e) => e.selfLogged).map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2">
                  {e.status === "approved" ? <Chip tone="success">Counted</Chip>
                    : e.status === "declined" ? <Chip tone="danger">Not counted</Chip>
                      : <Chip tone="warning">Waiting for the office</Chip>}
                  <span>{e.hours} hours of {e.course}, finished {formatDay(e.completedOn, zone)}.</span>
                  {e.status === "declined" && e.declineReason ? <span className="text-ink-700">{e.declineReason}</span> : null}
                  {e.certificates > 0 ? (
                    <a href={`/me/continuing-education/${e.id}/certificate`} target="_blank" rel="noreferrer"
                       className="text-blue-600 underline underline-offset-4">Certificate</a>
                  ) : null}
                  {e.status === "pending" ? (
                    <ActionForm action={withdrawCeHours} submit="Take it back" tone="quiet" className="inline-flex" hidden={{ id: e.id }} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {record.continuingEducationKinds.length > 0 ? (
            <div role="group" aria-label="Log hours of a course" className="mt-4 max-w-xl">
              <h3 className="text-sm font-semibold">Log hours of a course</h3>
              <p className="mt-1 text-xs text-ink-500">
                Took a course toward a renewal? Put the hours in with a photo of the certificate. The office looks at it
                and the hours count once they say yes.
              </p>
              <ActionForm action={logCeHours} submit="Send the hours" className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block sm:col-span-2">
                  <span className="text-sm font-medium text-ink-700">Toward</span>
                  <select name="certificationTypeId" required className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                    {record.continuingEducationKinds.map((k) => (
                      <option key={k.id} value={k.id}>{k.name}{k.hoursRequired ? ` (${Number(k.hoursRequired)} hours to renew)` : ""}</option>
                    ))}
                  </select>
                </label>
                <TextField label="Course" name="course" required maxLength={300} className="block sm:col-span-2" />
                <TextField label="Hours" name="hours" inputMode="decimal" required placeholder="4" />
                <TextField label="Day you finished" name="completedOn" type="date" required defaultValue={time.dateIn(new Date(), zone)} max={time.dateIn(new Date(), zone)} />
                <TextField label="Who ran it" name="provider" maxLength={200} />
                <TextField label="Certificate number" name="evidence" maxLength={500} />
                <label className="block sm:col-span-2">
                  <span className="text-sm font-medium text-ink-700">Photo of the certificate</span>
                  <input type="file" name="certificate" accept="image/*,application/pdf" capture="environment"
                         aria-label="Photo of the certificate" className="mt-2 block text-sm" />
                </label>
              </ActionForm>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * WHAT YOU ARE TOLD, AND WHERE
 *
 * One row per kind of notice, with a box for the app's bell, the phone app, a
 * text and, for the kinds that are emailed, an email. Texts are turned on here first, by the person, with their own number
 * and a box ticked beside the exact words they agree to; nobody in the office
 * can turn somebody else's on.
 */
function NoticeSettings({ told, zone }: { told: Awaited<ReturnType<typeof staffNotices.settings>>; zone: string }) {
  const box = "h-4 w-4 rounded border-steel-300";
  return (
    <section id="notices" className="mt-8" aria-labelledby="notices-heading">
      <h2 id="notices-heading" className="text-base font-semibold">What you are told, and where</h2>
      <p className="mt-1 text-sm text-ink-700">
        The bell at the top of the menu, the phone app{told.phones > 0 ? "" : " (you are not signed in to it on a phone)"}, a text to your own mobile, and for a licence or skill running out, an email to the address you sign in with.
      </p>
      <ActionForm action={saveNoticeSwitches} submit="Save what I am told" className="mt-3 space-y-3">
        <Table head={<><Th>Notice</Th><Th>In the app</Th><Th>Phone app</Th><Th>Text</Th><Th>Email</Th></>}>
          {told.kinds.map((k) => (
            <tr key={k.kind}>
              <Td><span className="font-medium">{k.label}</span><span className="block text-xs text-ink-500">{k.description}</span></Td>
              <Td><input type="checkbox" name={`${k.kind}.inApp`} defaultChecked={k.inApp} aria-label={`${k.label}: in the app`} className={box} /></Td>
              <Td><input type="checkbox" name={`${k.kind}.push`} defaultChecked={k.push} aria-label={`${k.label}: on the phone app`} className={box} /></Td>
              <Td>
                <input type="checkbox" name={`${k.kind}.text`} defaultChecked={k.text} disabled={!told.texts.on}
                       aria-label={`${k.label}: by text`} className={box} />
              </Td>
              <Td>
                {k.email === null
                  ? <span className="text-xs text-ink-500">Not emailed</span>
                  : <input type="checkbox" name={`${k.kind}.email`} defaultChecked={k.email} aria-label={`${k.label}: by email`} className={box} />}
              </Td>
            </tr>
          ))}
        </Table>
      </ActionForm>

      <h3 className="mt-6 text-sm font-semibold">Texts to your mobile</h3>
      {told.texts.on ? (
        <div className="mt-1 space-y-2 text-sm">
          <p className="text-ink-700">
            Texts go to <span className="font-mono">{told.texts.mobile}</span>, since {told.texts.since ? formatIn(told.texts.since, zone) : ""}.
            They come from the company&apos;s number, never at night (they wait until morning), and stop if you reply STOP.
          </p>
          <ActionForm action={turnOffTexts} submit="Turn texts off" tone="quiet" className="inline-flex" />
        </div>
      ) : !told.companyCanText ? (
        <p className="mt-1 text-sm text-ink-700">The company has no number that can send texts yet, so texts cannot be turned on.</p>
      ) : (
        <ActionForm action={turnOnTexts} submit="Turn texts on" className="mt-2 max-w-xl space-y-3">
          <TextField label="Your mobile number" name="mobilePhone" type="tel" required maxLength={40} placeholder="(512) 555-0142" />
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input type="checkbox" name="agreed" required className={`mt-0.5 ${box}`} />
            <span>{told.texts.agreement}</span>
          </label>
        </ActionForm>
      )}
    </section>
  );
}
