import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fieldOps, timeOff } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Empty } from "@/components/Table";
import { formatIn, todayIn } from "@/lib/dates";
import { requestTimeOff, withdrawTimeOff } from "../actions";

export const dynamic = "force-dynamic";

/**
 * MY TIME OFF
 *
 * Asking for days off, and what became of each ask. A request is only a
 * request: the board, the crew check and the booking page read approved
 * leave, so nothing changes for anybody until whoever approves the hours
 * says yes on Timesheets, Time off. A request nobody has answered yet can be
 * taken back here; an approved one is the approver's to take back.
 */
export default async function MyTimeOffPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;
  const header = (
    <>
      <Crumb href="/me">My record</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Time off</h1>
    </>
  );
  /** A place on the board, which is what time off here is days off from. Asked only of somebody who clocks in. */
  const onTheBoard = can(user.actor, "timeclock:own") && await fieldOps.isTechnician(ctx).catch(() => false);
  if (!onTheBoard) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        {header}
        <Empty title="Nothing to book off here">
          Time off here is days off the board, for people who go out to jobs. Ask the office for yours.
        </Empty>
      </div>
    );
  }
  const asks = await timeOff.list(ctx, { includeDeclined: true });
  const today = todayIn(zone);
  const day = (iso: string) => formatIn(iso, zone, { weekday: "short", month: "short", day: "numeric" });
  /** Whole days end at the midnight starting the next, so the last day is the instant before. */
  const lastDay = (iso: string) => day(new Date(new Date(iso).getTime() - 1).toISOString());

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      {header}
      <section className="mt-4" aria-labelledby="ask">
        <h2 id="ask" className="text-base font-semibold">Ask for days off</h2>
        <ActionForm action={requestTimeOff} submit="Ask for these days" className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField label="First day off" name="from" type="date" required min={today} />
          <TextField label="Last day off" name="to" type="date" min={today} />
          <TextField label="Why (optional)" name="reason" maxLength={500} className="block sm:col-span-2" />
        </ActionForm>
      </section>

      <section className="mt-8" aria-labelledby="asked">
        <h2 id="asked" className="text-base font-semibold">What you have asked for</h2>
        {asks.length === 0 ? (
          <p className="mt-1 text-sm text-ink-700">Nothing yet.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {[...asks].reverse().map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                {a.standing === "approved"
                  ? <Chip tone="success">Approved</Chip>
                  : a.standing === "declined"
                    ? <Chip tone="neutral">Declined or taken back</Chip>
                    : <Chip tone="warning">Waiting for an answer</Chip>}
                <span>{day(a.startsAt) === lastDay(a.endsAt) ? day(a.startsAt) : `${day(a.startsAt)} to ${lastDay(a.endsAt)}`}</span>
                {a.reason ? <span className="text-ink-500">{a.reason}</span> : null}
                {a.standing === "requested" ? (
                  <ActionForm action={withdrawTimeOff} submit="Take it back" tone="quiet" className="inline-flex" hidden={{ id: a.id }} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
