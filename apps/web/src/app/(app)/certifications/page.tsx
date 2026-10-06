import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { people, peopleRecords } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "./ActionForm";
import { ExpiringList, HoldingsByPerson } from "./Holdings";

export const dynamic = "force-dynamic";

const input = "h-9 rounded border border-steel-300 px-2 text-sm";

/**
 * CERTIFICATIONS
 *
 * Licences and certificates: who holds what, until when, whether anybody
 * has seen the card, and what is about to run out. A certification type can
 * name the skills it unlocks, which is what lets dispatch refuse to send an
 * unlicensed technician to work that needs one.
 *
 * Hours of continuing education a person logged themselves wait here for the
 * office, with the photograph of the certificate, and count toward a renewal
 * only once approved. Skills with their own expiry are listed beside the
 * certifications that are about to run out.
 */
export default async function CertificationsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "compliance:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Certifications" />
        <Empty title="Not shown to your role">Certifications need the compliance permission.</Empty>
      </div>
    );
  }

  const writes = can(user.actor, "compliance:write");
  const [{ types }, { certifications }, { expiring }, waiting, skillsDue] = await Promise.all([
    people.handlers.listCertificationTypes(ctx),
    people.handlers.listCertifications(ctx, {}),
    people.handlers.listExpiringCertifications(ctx, {}),
    peopleRecords.pendingContinuingEducation(ctx),
    /** Skills are the roster's records (`user:read`), so somebody who reads only certifications sees none. */
    can(user.actor, "user:read") ? peopleRecords.expiringSkills(ctx, {}) : Promise.resolve([]),
  ]);
  const technicians = writes && can(user.actor, "user:read")
    ? (await people.handlers.listPeople(ctx, {})).people.filter((p) => p.technicianId && p.active)
    : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Certifications" count={certifications.length} />

      <h2 className="mt-6 text-base font-semibold">Due for renewal</h2>
      <ExpiringList rows={expiring} />

      {skillsDue.length > 0 && (
        <section className="mt-8" aria-label="Skills due for renewal">
          <h2 className="text-base font-semibold">Skills due for renewal</h2>
          <p className="mt-1 text-sm text-ink-500">
            A skill with its own last day stops counting for the board from the day after it. Set a new last day on the
            person&apos;s page when it has been shown again.
          </p>
          <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
            {skillsDue.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
                <span className="flex-1"><span className="font-medium">{s.technicianName}</span> · <span className="font-mono">{s.skill}</span></span>
                <span className="text-ink-700">{s.expiresOn}</span>
                {s.current
                  ? <Chip tone="warning">{s.daysRemaining} {s.daysRemaining === 1 ? "day" : "days"} left</Chip>
                  : <Chip tone="danger">Ran out {-s.daysRemaining} {s.daysRemaining === -1 ? "day" : "days"} ago</Chip>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {waiting.length > 0 && (
        <section className="mt-8" aria-label="Hours waiting for the office">
          <h2 className="text-base font-semibold">Hours waiting for you</h2>
          <p className="mt-1 text-sm text-ink-500">
            People logged these themselves. Look at the certificate, then approve them. Only approved hours count toward a renewal.
          </p>
          <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
            {waiting.map((w) => (
              <li key={w.id} className="bg-canvas p-3 text-sm">
                <p>
                  <span className="font-medium">{w.technicianName}</span>: {w.hours} hours of {w.course}
                  {w.provider ? `, ${w.provider}` : ""}, finished {w.completedOn}, toward {w.certificationName}.
                  {w.evidence ? ` Certificate number ${w.evidence}.` : ""}{" "}
                  {w.certificates > 0
                    ? <a href={`/certifications/continuing-education/${w.id}/certificate`} target="_blank" rel="noreferrer" className="text-blue-600 underline underline-offset-4">Look at the certificate</a>
                    : <span className="text-amber-700">No certificate was attached.</span>}
                </p>
                {writes && (
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <ActionForm op="ce-approve" label="Approve" hidden={{ id: w.id }} />
                    <ActionForm op="ce-decline" label="Decline" quiet hidden={{ id: w.id }} className="flex items-center gap-2">
                      <input name="reason" required aria-label={`Why ${w.technicianName}'s hours are declined`} placeholder="Why, so they can fix it" className={`${input} w-64`} />
                    </ActionForm>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="mt-8 text-base font-semibold">Who holds what</h2>
      <HoldingsByPerson
        rows={certifications}
        controls={writes ? (h) => (
          <div className="flex flex-wrap gap-2">
            {!h.verifiedAt && (
              <ActionForm op="verify" label="I have seen the card" quiet>
                <input type="hidden" name="id" value={h.id} />
              </ActionForm>
            )}
            {h.status === "active" && (
              <ActionForm op="status" label="Suspend" quiet>
                <input type="hidden" name="id" value={h.id} />
                <input type="hidden" name="status" value="suspended" />
                <input name="reason" required placeholder="Why" className={`${input} h-8`} />
              </ActionForm>
            )}
            {h.status === "suspended" && (
              <ActionForm op="status" label="Reinstate" quiet>
                <input type="hidden" name="id" value={h.id} />
                <input type="hidden" name="status" value="active" />
              </ActionForm>
            )}
            {h.status !== "revoked" && (
              <ActionForm op="status" label="Revoke" quiet>
                <input type="hidden" name="id" value={h.id} />
                <input type="hidden" name="status" value="revoked" />
                <input name="reason" required placeholder="Why" className={`${input} h-8`} />
              </ActionForm>
            )}
          </div>
        ) : undefined}
      />

      {writes && technicians.length > 0 && types.some((t) => t.active) && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Record a certification</h2>
          <p className="mt-1 text-sm text-ink-500">Renewing is recording it again with the new dates; the old one stays on the record.</p>
          <ActionForm op="record" label="Record" className="mt-2 flex flex-wrap items-end gap-2">
            <select name="technicianId" required className={input}>
              {technicians.map((t) => <option key={t.technicianId!} value={t.technicianId!}>{t.displayName ?? t.name ?? t.email}</option>)}
            </select>
            <select name="certificationTypeId" required className={input}>
              {types.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input name="reference" placeholder="Licence number" className={input} />
            <label className="grid gap-1 text-xs text-ink-500">Issued<input name="issuedOn" type="date" className={input} /></label>
            <label className="grid gap-1 text-xs text-ink-500">Expires<input name="expiresOn" type="date" className={input} /></label>
          </ActionForm>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-base font-semibold">Kinds this company recognises</h2>
        {types.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {types.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t.name}</span>
                <span className="text-ink-500">{t.code}{t.authority ? ` · ${t.authority}` : ""}</span>
                {t.grantsSkills.length > 0 && <span className="text-ink-500">· unlocks {t.grantsSkills.join(", ")}</span>}
                {!t.expires && <Chip tone="neutral">Does not expire</Chip>}
                {!t.active && <Chip tone="neutral">Retired</Chip>}
              </li>
            ))}
          </ul>
        )}
        {writes && (
          <ActionForm op="type" label="Add kind" className="mt-3 flex flex-wrap items-end gap-2">
            <input name="code" required placeholder="EPA-608" className={`${input} w-28`} />
            <input name="name" required placeholder="EPA 608 Universal" className={input} />
            <input name="authority" placeholder="Issued by" className={input} />
            <input name="grantsSkills" placeholder="Skills it unlocks, comma separated" className={`${input} min-w-64`} />
            <label className="flex h-9 items-center gap-1 text-sm"><input type="checkbox" name="expires" defaultChecked /> Expires</label>
            <input name="defaultValidMonths" inputMode="numeric" placeholder="Valid months" className={`${input} w-28`} />
            <input name="renewalLeadDays" inputMode="numeric" placeholder="Warn days ahead" className={`${input} w-32`} />
          </ActionForm>
        )}
      </section>
    </div>
  );
}
