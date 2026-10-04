import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { timeOff } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { leaveSpan } from "@/lib/dates";
import { approve, decline } from "./actions";

export const dynamic = "force-dynamic";

/**
 * TIME OFF, FOR WHOEVER APPROVES THE HOURS
 *
 * The requests waiting for an answer, oldest day first, and the leave already
 * granted that is still to come. Approving is what the board, the crew check
 * and the booking page read: until then a request changes nothing for
 * anybody. A branch manager given approval sees their branch's people only.
 *
 * Taking back an approval needs a reason, because somebody has arranged their
 * week around it.
 */
export default async function TimeOffPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "timesheet:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Time off" />
        <Empty title="Time off is not part of your access">Somebody who approves timesheets answers these.</Empty>
      </div>
    );
  }
  const answers = can(user.actor, "timesheet:approve");
  const waiting = answers ? await timeOff.pending(ctx) : [];
  const granted = await timeOff.upcoming(ctx);
  const span = (from: string, to: string) => leaveSpan(from, to, zone);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Time off" />

      <section className="mt-6" aria-labelledby="waiting">
        <h2 id="waiting" className="text-base font-semibold">Waiting for an answer</h2>
        {!answers ? (
          <p className="mt-1 text-sm text-ink-700">Answering requests needs the Approve timesheets permission.</p>
        ) : waiting.length === 0 ? (
          <Empty title="Nothing waiting">Requests people make from My record appear here.</Empty>
        ) : (
          <Table head={<><Th>Who</Th><Th>Days</Th><Th>Why</Th><Th>{""}</Th></>}>
            {waiting.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium">{r.technicianName}</Td>
                <Td>{span(r.startsAt, r.endsAt)}</Td>
                <Td className="text-ink-700">{r.reason ?? ""}</Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    <ActionForm action={approve} submit={`Approve ${r.technicianName ?? ""}`.trim()} hidden={{ id: r.id }}
                                className="flex flex-col items-start gap-2" />
                    <ActionForm action={decline} submit="Decline" tone="quiet" hidden={{ id: r.id }}
                                className="flex flex-col items-start gap-2" />
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-10" aria-labelledby="granted">
        <h2 id="granted" className="text-base font-semibold">Approved, still to come</h2>
        {granted.length === 0 ? (
          <p className="mt-1 text-sm text-ink-700">Nobody has approved leave coming up.</p>
        ) : (
          <Table head={<><Th>Who</Th><Th>Days</Th><Th>Why</Th>{answers ? <Th>{""}</Th> : null}</>}>
            {granted.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium">{r.technicianName}</Td>
                <Td>{span(r.startsAt, r.endsAt)}</Td>
                <Td className="text-ink-700">{r.reason ?? ""}</Td>
                {answers ? (
                  <Td>
                    <ActionForm action={decline} submit="Take it back" tone="danger" hidden={{ id: r.id }}
                                className="flex flex-wrap items-end gap-2">
                      <input name="reason" required aria-label={`Why ${r.technicianName ? `${r.technicianName}'s` : "their"} leave is taken back`}
                             placeholder="Why, for them" className="h-9 w-48 rounded border border-steel-300 px-2 text-sm" />
                    </ActionForm>
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
