import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { softphone, telephony } from "@opentradesos/api/services";
import { assertCan, can } from "@opentradesos/core";
import { Chip, Phone as PhoneNumber } from "@opentradesos/ui";
import { PageHeader, Empty, Table, Th, Td } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { Softphone } from "./Softphone";
import { softphoneToken, takeCalls } from "./actions";

export const dynamic = "force-dynamic";

/**
 * THE BROWSER PHONE
 *
 * Ring a customer from the company's number, and take the company's calls
 * here while "Take calls here" is on: a ring group rings this browser instead
 * of the person's phone. The phone itself is the carrier's browser library,
 * loaded only when somebody switches it on, so nobody who never uses it
 * downloads it.
 *
 * A screen of its own because a call lives as long as the page does, and
 * every link in the rail is a whole new page. Somebody taking calls keeps this
 * open in a tab of its own.
 */
export default async function PhonePage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "call:place");
  const ctx = { actor: user.actor, db: getDb() };
  const status = await softphone.status(ctx);
  const recent = can(user.actor, "message:read")
    ? (await telephony.callsFor(ctx, { limit: 50 }))
      .filter((c) => c.placedByUserId === user.actor.userId || c.answeredByUserId === user.actor.userId)
      .slice(0, 15)
    : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Phone" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Call customers from your company&apos;s number, and take calls here when you are in a ring group. Keep this
        page open in a tab of its own while you are taking calls: leaving it ends the call you are on.
      </p>

      {status.ready ? (
        <Softphone callerId={status.callerId ?? ""} takingCalls={status.takingCalls}
                   getToken={softphoneToken} setTakingCalls={takeCalls} />
      ) : (
        <Empty title="Not ready">{status.reason}</Empty>
      )}

      <section className="mt-10" aria-labelledby="recent">
        <h2 id="recent" className="text-base font-semibold">Your recent calls</h2>
        {recent.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">Calls you make or answer here are listed once they are logged.</p>
        ) : (
          <Table label="Your recent calls" head={<><Th>When</Th><Th>Which way</Th><Th>Number</Th><Th>How it went</Th></>}>
            {recent.map((call) => (
              <tr key={call.id}>
                <Td>{formatIn((call.startedAt ?? call.createdAt).toISOString(), user.organizationTimezone)}</Td>
                <Td>{call.direction === "outbound" ? "You called" : "You answered"}</Td>
                <Td><PhoneNumber value={call.direction === "outbound" ? call.toE164 : call.fromE164} /></Td>
                <Td>
                  <Chip tone={call.status === "completed" || call.status === "in_progress" ? "success" : "neutral"}>
                    {call.status === "completed" || call.status === "in_progress" ? "Answered" : call.status.replace(/_/g, " ")}
                  </Chip>
                  {call.durationSeconds ? <span className="ml-2 text-xs text-ink-500 tabular-nums">{Math.floor(call.durationSeconds / 60)}m {call.durationSeconds % 60}s</span> : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
