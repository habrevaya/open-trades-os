import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { softphone, telephony, callTransfers } from "@opentradesos/api/services";
import { assertCan, can } from "@opentradesos/core";
import { Chip, Phone as PhoneNumber } from "@opentradesos/ui";
import { PageHeader, Empty, Table, Th, Td } from "@/components/Table";
import { ActionForm, Select } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { Softphone, type Handover } from "./Softphone";
import { softphoneToken, takeCalls, holdCaller, passCaller, handOver, callOff } from "./actions";

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
  const [current, targets] = await Promise.all([callTransfers.current(ctx), callTransfers.targets(ctx)]);
  const who = current ? current.customerName ?? current.from : "";
  const handover: Handover | null = !current || !current.transferId
    ? null
    : current.state === "holding"
      ? { kind: "holding", callId: current.id, who }
      : current.state === "consulting" && !current.consultAnswered
        ? { kind: "consulting", consult: `transfer:${current.transferId}`, name: current.consultWith ?? "your colleague" }
        : null;
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

      {current ? (
        <section aria-labelledby="your-call" className="mt-6 max-w-md rounded-md border border-steel-300 p-4">
          <h2 id="your-call" className="text-base font-semibold">Your call</h2>
          <p className="mt-1 text-sm text-ink-700">
            {current.state === "talking" ? `On a call with ${who}.` : null}
            {current.state === "holding" ? `${who} is on hold. Take them back with the phone below, or pass them on.` : null}
            {current.state === "consulting"
              ? `${who} is on hold while you talk to ${current.consultWith ?? "your colleague"}.${current.consultAnswered ? "" : " Ring them with the phone below."}`
              : null}
            {current.state === "handing_over" ? `Handing ${who} over to ${current.consultWith ?? "your colleague"}.` : null}
          </p>
          {current.state === "talking" ? (
            <ActionForm action={holdCaller} submit="Put on hold" tone="quiet" hidden={{ id: current.id }} className="mt-3" />
          ) : null}
          {current.state === "talking" || current.state === "holding" ? (
            <ActionForm action={passCaller} submit="Pass the caller on" hidden={{ id: current.id }} className="mt-4 space-y-3">
              <Select label="Pass them to" name="to" options={[
                ...targets.people.map((p) => ({ value: `person:${p.userId}`, label: p.takingCalls ? `${p.name} (in the browser)` : p.name })),
                ...targets.ringGroups.map((g) => ({ value: `ring_group:${g.id}`, label: `The ${g.name} ring group` })),
                ...targets.queues.map((q) => ({ value: `queue:${q.id}`, label: `The ${q.name} waiting line` })),
              ]} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="warm" />
                Talk to them first (a colleague only)
              </label>
              <p className="text-xs text-ink-500">
                Without talking first, the caller goes straight there and your call ends. Talking first puts the caller
                on hold while you ring your colleague, then you hand them over.
              </p>
            </ActionForm>
          ) : null}
          {current.state === "consulting" && current.transferId ? (
            <div className="mt-3 flex flex-wrap gap-3">
              {current.consultAnswered ? (
                <ActionForm action={handOver} submit="Hand over the caller" hidden={{ id: current.transferId }} className="" />
              ) : null}
              <ActionForm action={callOff} submit="Do not pass them on" tone="quiet" hidden={{ id: current.transferId }} className="" />
            </div>
          ) : null}
        </section>
      ) : null}

      {status.ready ? (
        <Softphone callerId={status.callerId ?? ""} takingCalls={status.takingCalls}
                   getToken={softphoneToken} setTakingCalls={takeCalls} handover={handover} />
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
