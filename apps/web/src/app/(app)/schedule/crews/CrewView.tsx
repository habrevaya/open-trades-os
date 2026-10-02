import type { ReactNode } from "react";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

export interface CrewRow {
  id: string;
  name: string;
  productionRatePerDay: string | null;
  productionUnit: string | null;
  skills: string[];
  color: string | null;
  active: boolean;
  members: { technicianId: string; displayName: string; isLead: boolean; active: boolean }[];
}

export interface ShiftRow {
  id: string;
  technicianId: string;
  technicianName: string;
  startsAt: string;
  endsAt: string;
  rateMultiplier: string | null;
}

/**
 * THE CREWS, AND WHO LEADS EACH
 *
 * A crew is the dispatch unit for work one person cannot do: two people and a
 * chipper, three and a lift. The lead is shown because the lead is who the office
 * calls, and a crew with no lead is marked rather than left looking complete.
 *
 * A production rate is shown only WITH its unit. "Eight hundred a day" is not a
 * number anybody can schedule with: it is eight hundred square feet, or linear
 * feet, or cubic yards, and the three are different jobs. The service refuses one
 * without the other for that reason, so a rate with no unit here would be a row
 * the service cannot have produced.
 */
export function Crews({
  crews, controls,
}: {
  crews: CrewRow[];
  controls?: ((crew: CrewRow) => ReactNode) | undefined;
}) {
  if (crews.length === 0) {
    return (
      <Empty title="No crews yet">
        A crew is for work one person cannot do. Name one, put people on it, and the dispatch board
        will refuse it a job it is not qualified or equipped for.
      </Empty>
    );
  }
  return (
    <Table label="Crews" head={
      <><Th>Crew</Th><Th>Who</Th><Th>Capacity</Th>{controls ? <Th /> : null}</>
    }>
      {crews.map((crew) => (
        <tr key={crew.id} className={crew.active ? undefined : "text-ink-500"}>
          <Td>
            <span className="font-medium">{crew.name}</span>
            {crew.active ? null : <Chip tone="neutral" className="ml-2">Retired</Chip>}
            {crew.skills.length > 0 ? (
              <span className="mt-1 flex flex-wrap gap-1">
                {crew.skills.map((skill) => <Chip key={skill} tone="info">{skill}</Chip>)}
              </span>
            ) : null}
          </Td>
          <Td>
            {crew.members.length === 0 ? (
              <span className="text-amber-700">Nobody on it</span>
            ) : (
              <ul className="space-y-0.5">
                {crew.members.map((member) => (
                  <li key={member.technicianId}>
                    {member.displayName}
                    {member.isLead ? <span className="ml-1 text-xs font-medium text-ink-700">lead</span> : null}
                    {member.active ? null : <span className="ml-1 text-xs text-red-600">no longer active</span>}
                  </li>
                ))}
                {/*
                  A crew with people and no lead is called out. The lead is who
                  the office rings when a job goes wrong, and a crew without one
                  looks complete on every other screen.
                */}
                {crew.members.some((member) => member.isLead) ? null : (
                  <li className="text-amber-700">No lead</li>
                )}
              </ul>
            )}
          </Td>
          <Td className="text-ink-700">
            {crew.productionRatePerDay && crew.productionUnit
              ? (
                <span className="tabular-nums">
                  {rate(crew.productionRatePerDay)} {crew.productionUnit} a day
                </span>
              )
              : <span className="text-ink-500">Not declared</span>}
          </Td>
          {controls ? <Td>{controls(crew)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

/**
 * A production rate, trimmed.
 *
 * The column is `numeric(14,4)` like every other number in this schema, so the
 * value arrives as "800.0000" and a browser test caught it on the screen. Four
 * decimal places are right for money, where a cent matters and a rounded figure
 * will not reconcile against a ledger, and wrong for a count of square feet: an
 * operator reads "800.0000 square feet a day" as a system that does not know what
 * it is measuring.
 *
 * Trailing zeros only. A rate somebody entered as 12.5 keeps its half, because
 * half a linear foot an hour is a real cadence and rounding it would change a
 * capacity figure the schedule depends on.
 */
const rate = (value: string): string => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
};

/**
 * WHO IS ON CALL, AND THE SENTENCE WHEN NOBODY IS
 *
 * Null is said in words, never rendered as a blank. A blank where a name should
 * be reads as "fine" to the person looking at it, and the honest reading is that
 * the company has nobody rostered and somebody has to fix it before tonight.
 *
 * The window is half open, `[starts, ends)`, which is the same rule the service
 * enforces: a handover at six is one person until six and the next from six. A
 * closed interval makes that instant belong to both or to neither, and "neither"
 * silently drops a call.
 */
export function OnCall({
  now, shifts, zone, formatAt, windowDays,
}: {
  now: { technicianName: string } | null;
  shifts: ShiftRow[];
  zone: string;
  formatAt: (iso: string, zone: string) => string;
  /**
   * How far ahead the list looks, said on the screen.
   *
   * The service windows the rota deliberately: a rotation table is one row per
   * weekend forever and this screen is "the next few weeks" rather than the
   * history of who had the phone in 2024. But an empty list with no window stated
   * is ambiguous between "nobody is scheduled" and "nothing in the next month",
   * and those are different facts. A browser test hit exactly that: a shift
   * scheduled outside the window read as no rota at all.
   */
  windowDays: number;
}) {
  return (
    <>
      <p className="mt-3 text-sm">
        {now === null ? (
          <span className="font-medium text-red-600">
            Nobody is on call right now. A call tonight reaches no one.
          </span>
        ) : (
          <>On call now: <span className="font-medium">{now.technicianName}</span></>
        )}
      </p>

      {shifts.length === 0 ? (
        <Empty title={`Nothing rostered in the next ${windowDays} days`}>
          Put somebody on call for a window. Two rows covering one instant are refused, because two
          people told different things is a thing a customer discovers at two in the morning.
        </Empty>
      ) : (
        <>
        <p className="mt-3 text-xs text-ink-500">The next {windowDays} days.</p>
        <Table label="On call" head={<><Th>Who</Th><Th>From</Th><Th>Until</Th><Th>Rate</Th></>}>
          {shifts.map((shift) => (
            <tr key={shift.id}>
              <Td className="font-medium">{shift.technicianName}</Td>
              <Td className="tabular-nums">{formatAt(shift.startsAt, zone)}</Td>
              <Td className="tabular-nums">{formatAt(shift.endsAt, zone)}</Td>
              <Td className="text-ink-700">
                {/*
                  A multiplier is a statement about what somebody is owed, which
                  is why setting one needs `payroll:configure` and not merely
                  dispatch rights. Shown as a multiple rather than as money,
                  because the money is the labour rate it multiplies.
                */}
                {shift.rateMultiplier
                  ? <span className="tabular-nums">{shift.rateMultiplier}&times; labour</span>
                  : <span className="text-ink-500">Normal</span>}
              </Td>
            </tr>
          ))}
        </Table>
        </>
      )}
    </>
  );
}
