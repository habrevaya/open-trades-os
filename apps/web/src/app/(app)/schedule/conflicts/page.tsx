import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { equipment, fieldOps } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { actOnConflict } from "./actions";

export const dynamic = "force-dynamic";

/** What the phone was doing, in the office's words. */
const KIND: Record<string, string> = {
  "visit.en_route": "On the way", "visit.arrive": "Arrived", "visit.start": "Started work",
  "visit.complete": "Finished", "visit.pause": "Paused", "visit.note": "A note", "visit.call_off": "Called off a visit",
  "timeclock.punch_in": "Punched in", "timeclock.punch_out": "Punched out",
  "service_report.set_field": "A service report answer", "service_report.submit": "Sent a service report",
  "visit.checklist_item": "A checklist item", "visit.add_line": "Added a part or charge",
  "equipment.record": "A unit found on site", "attachment.attach": "A photo or file",
  "signature.capture": "A signature", "payment.collect": "Took a payment", "inspection.record": "An inspection",
  "estimate.create": "Wrote an estimate", "estimate.approve": "The customer said yes on the phone",
  "estimate.decline": "The customer said no on the phone", "invoice.raise": "Raised an invoice on site",
};

/** Where to look, for the kinds whose subject is certain. */
function subjectHref(kind: string, subjectId: string | null, payload: Record<string, unknown>): { href: string; label: string } | null {
  if (kind === "equipment.record" && typeof payload["propertyId"] === "string") {
    return { href: `/properties/${payload["propertyId"]}`, label: "Open the address" };
  }
  if (!subjectId) return null;
  if (kind.startsWith("service_report.")) return { href: `/service-reports/${subjectId}`, label: "Open the report" };
  if (kind.startsWith("visit.")) return { href: `/visits/${subjectId}`, label: "Open the visit" };
  return null;
}

const said = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * FIELD CONFLICTS
 *
 * Things a technician's phone did that the office has to look at:
 * `GET /v1/field/conflicts` (`visit:read`, the people this person may see the
 * day of), newest first. The work was recorded; a conflict is a question
 * about it (they arrived at a visit somebody had cancelled, the customer was
 * shown a different figure, a unit's serial is on file somewhere else). Each
 * says what happened in words, links to what it is about, and is marked dealt
 * with (`visit:write`). A unit the phone could not add has the office's two
 * answers on it: move the one on file here, or add it as a different unit.
 */
export default async function FieldConflictsPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "visit:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Field conflicts" />
        <Empty title="Visits are not part of your access">Somebody who can change roles can turn this on.</Empty>
      </div>
    );
  }

  const includeResolved = (await searchParams).all === "1";
  const { data: conflicts } = await fieldOps.conflicts(ctx, { limit: 200, includeResolved });
  const resolves = can(user.actor, "visit:write");
  const units = resolves && can(user.actor, "equipment:write") && can(user.actor, "equipment:read");

  /** For each unit held for the office, the units on file with the same serial, read now rather than when it was held. */
  const matchesFor = new Map<string, Awaited<ReturnType<typeof equipment.matchSerial>>>();
  if (units) {
    for (const c of conflicts) {
      const serial = said(c.payload["serialNumber"]);
      if (c.kind === "equipment.record" && !c.resolvedAt && serial) {
        matchesFor.set(c.id, await equipment.matchSerial(ctx, { serialNumber: serial }));
      }
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/schedule">Schedule</Crumb>
      <PageHeader title="Field conflicts" count={conflicts.length} />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        Things a technician&apos;s phone recorded that need somebody in the office to look. The work is on the record
        already. Look at what it is about, sort it out, then mark it dealt with.
      </p>
      <p className="mt-2 flex gap-3 text-sm">
        <a href="/schedule/conflicts" className="text-blue-600 underline underline-offset-4">Waiting</a>
        <a href="/schedule/conflicts?all=1" className="text-blue-600 underline underline-offset-4">Include the ones dealt with</a>
      </p>

      {conflicts.length === 0 ? (
        <Empty title="Nothing waiting">When a phone records something the office has to look at, it shows here.</Empty>
      ) : (
        <ul className="mt-4 space-y-3">
          {conflicts.map((c) => {
            const link = subjectHref(c.kind, c.subjectId, c.payload);
            const matches = matchesFor.get(c.id) ?? [];
            const here = said(c.payload["propertyId"]);
            const unit = [said(c.payload["manufacturer"]), said(c.payload["model"])].filter(Boolean).join(" ")
              || said(c.payload["category"]) || "A unit";
            return (
              <li key={c.id} data-testid="conflict" className="rounded-md border border-steel-200 p-4 text-sm">
                <p className="font-medium">
                  {KIND[c.kind] ?? c.kind.replace(/[._]/g, " ")}, {c.technicianName}, {formatIn(c.occurredAt, zone)}
                  {c.resolvedAt ? <span className="ml-2 font-normal text-ink-500">Dealt with {formatIn(c.resolvedAt, zone)}</span> : null}
                </p>
                <p className="mt-1 text-ink-700">{c.conflict}</p>
                {c.kind === "equipment.record" ? (
                  <p className="mt-1 text-ink-700">
                    The phone sent: {unit}
                    {said(c.payload["serialNumber"]) ? `, serial ${said(c.payload["serialNumber"])}` : ""}
                    {said(c.payload["location"]) ? `, ${said(c.payload["location"])}` : ""}.
                  </p>
                ) : null}
                {link ? <a href={link.href} className="mt-1 inline-block text-blue-600 underline underline-offset-4">{link.label}</a> : null}

                {!c.resolvedAt && units && c.kind === "equipment.record" && here ? (
                  <div className="mt-3 space-y-2 rounded border border-steel-200 bg-canvas p-3">
                    <p className="text-ink-700">
                      If it is the same unit, move the one on file here: its history comes with it. If it really is a
                      different unit with the same serial, add it.
                    </p>
                    {matches.filter((m) => !m.retired && m.propertyId !== here).map((m) => (
                      <ActionForm key={m.id} action={actOnConflict} submit="Move it here" tone="quiet"
                                  hidden={{ id: c.id, op: "move", equipmentId: m.id }}
                                  className="flex flex-wrap items-center gap-3">
                        <span>
                          <a href={`/equipment/${m.id}`} className="underline underline-offset-4">
                            {[m.tag, m.manufacturer, m.model].filter(Boolean).join(" ") || m.category}
                          </a>{" "}
                          at {m.address}{m.customer ? `, ${m.customer.name}` : ""}
                        </span>
                      </ActionForm>
                    ))}
                    {matches.filter((m) => m.retired).map((m) => (
                      <p key={m.id} className="text-ink-500">
                        <a href={`/equipment/${m.id}`} className="underline underline-offset-4">
                          {[m.tag, m.manufacturer, m.model].filter(Boolean).join(" ") || m.category}
                        </a>{" "}
                        at {m.address} was taken off the register, so it is not moved from here. Open it to see its history.
                      </p>
                    ))}
                    <ActionForm action={actOnConflict} submit="Add it as a different unit" tone="quiet"
                                hidden={{ id: c.id, op: "add" }} className="flex flex-wrap items-center gap-3" />
                  </div>
                ) : null}

                {!c.resolvedAt && resolves ? (
                  <ActionForm action={actOnConflict} submit="Mark it dealt with" tone="quiet" hidden={{ id: c.id, op: "resolve" }}
                              className="mt-3 flex flex-wrap items-center gap-3">
                    <input name="note" maxLength={1000} placeholder="What you did (optional)" aria-label="What you did"
                           className="h-9 w-72 rounded border border-steel-300 bg-canvas px-2 text-sm" />
                  </ActionForm>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
