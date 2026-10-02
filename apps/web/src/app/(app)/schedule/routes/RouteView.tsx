import type { ReactNode } from "react";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

export interface RouteRow {
  id: string;
  name: string;
  dayName: string | null;
  technicianId: string | null;
  crewId: string | null;
  targetStopCount: number | null;
  startsAt: string | null;
  travelMinutesBetweenStops: number | null;
  stopCount: number;
  active: boolean;
}

export interface StopRow {
  id: string;
  propertyId: string;
  addressLine1: string;
  sequence: number;
  estimatedMinutes: number | null;
  intervalDays: number | null;
  lastServicedOn: string | null;
  nextDueOn: string | null;
  pricePerStop: string | null;
  active: boolean;
}

export interface DensityRow {
  stopCount: number;
  targetStopCount: number | null;
  overTarget: boolean | null;
  serviceMinutes: number;
  travelMinutes: number | null;
  totalMinutes: number;
  travelDeclared: boolean;
  overtimeAfterMinutes: number | null;
  minutesOverThreshold: number | null;
  runsIntoOvertime: boolean | null;
  explanation: string;
}

/**
 * THE ROUTES, BY WEEKDAY
 *
 * A route IS a weekday: "the Tuesday route" is how the business talks about it,
 * and the service refuses to materialise one onto the wrong day for that reason.
 * So the day is a column rather than a detail.
 *
 * Exactly one servicer, never both and never neither. A route with neither
 * materialises visits nobody is responsible for, which looks on the board exactly
 * like unassigned work and will sit there; a route with both has two answers to
 * every question after that. The service refuses both halves, so a row here with
 * no servicer at all is one the service cannot have produced, which is why the
 * cell says which it is rather than leaving it blank.
 */
export function Routes({
  routes, servicerName, controls,
}: {
  routes: RouteRow[];
  servicerName: (route: RouteRow) => string;
  controls?: ((route: RouteRow) => ReactNode) | undefined;
}) {
  if (routes.length === 0) {
    return (
      <Empty title="No routes yet">
        A route is a weekday, a servicer and a list of stops in the order they are driven. Once it
        exists, turning it into a day&apos;s work is one press and is safe to repeat.
      </Empty>
    );
  }
  return (
    <Table label="Routes" head={
      <><Th>Route</Th><Th>Day</Th><Th>Who</Th><Th className="text-right">Stops</Th>{controls ? <Th /> : null}</>
    }>
      {routes.map((route) => (
        <tr key={route.id} className={route.active ? undefined : "text-ink-500"}>
          <Td>
            <span className="font-medium">{route.name}</span>
            {route.active ? null : <Chip tone="neutral" className="ml-2">Paused</Chip>}
            {route.startsAt ? (
              <span className="block text-xs text-ink-500">Starts {route.startsAt}</span>
            ) : null}
          </Td>
          <Td>{route.dayName ?? <span className="text-amber-700">No day</span>}</Td>
          <Td>{servicerName(route)}</Td>
          <Td className="text-right tabular-nums">
            {route.stopCount}
            {route.targetStopCount === null ? null : (
              <span className="text-ink-500"> of {route.targetStopCount}</span>
            )}
          </Td>
          {controls ? <Td>{controls(route)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

/**
 * WILL THIS DAY FIT
 *
 * Density is the whole economics of a route business: the revenue is stops times
 * price per stop and the cost is the driver's day. An operator adding a fifteenth
 * stop is making the only decision that matters in their business, and today they
 * make it by feel and find out on Friday at time and a half.
 *
 * THREE VALUES AND NOT TWO. `runsIntoOvertime` is true, false or NULL, and null is
 * a real answer: the question cannot be settled from what the company has
 * declared, which is a different thing from a day that fits. Rendering null as
 * "fits" is the mistake this screen exists to avoid.
 *
 * A total with no declared travel is a FLOOR and says so. Treating the drive as
 * zero would tell somebody a fifteen stop day fits.
 */
export function Fit({ density }: { density: DensityRow }) {
  const tone = density.runsIntoOvertime === true
    ? "text-red-600"
    : density.runsIntoOvertime === false ? "text-green-700" : "text-amber-700";
  return (
    <div className="mt-3 rounded-md border border-steel-200 bg-canvas p-4">
      <p className={`text-sm font-medium ${tone}`}>
        {density.runsIntoOvertime === true
          ? `Runs into overtime by ${density.minutesOverThreshold ?? 0} minutes`
          : density.runsIntoOvertime === false
            ? "Fits the working day"
            : "Cannot tell from what has been declared"}
      </p>
      <p className="mt-1 text-sm text-ink-700">{density.explanation}</p>
      <p className="mt-2 text-sm tabular-nums text-ink-700">
        {density.stopCount} stops, {density.serviceMinutes} minutes of work
        {density.travelDeclared
          ? `, ${density.travelMinutes} minutes driving`
          : ", driving not declared"}
        {". "}
        {/*
          "At least" when travel is undeclared, because the total is a floor
          rather than a figure. The word is the whole difference between a number
          somebody can act on and one that misleads.
        */}
        <span className="font-medium">
          {density.travelDeclared ? "" : "At least "}{density.totalMinutes} minutes
        </span>
        {density.overtimeAfterMinutes === null
          ? ", against no declared threshold"
          : `, against ${density.overtimeAfterMinutes} before overtime`}
        .
      </p>
      {density.overTarget === true ? (
        <p className="mt-1 text-sm text-amber-700">
          Over the target stop count the operator set for this route.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The stops, in the order they are driven.
 *
 * `nextDueOn` is counted from the last visit ACTUALLY serviced rather than from
 * the one that was scheduled, which is why a stop can be on a route and not due
 * today. A stop that is not due is shown with its date rather than hidden, so
 * somebody looking at a short day can see why.
 */
export function Stops({
  stops, controls,
}: {
  stops: StopRow[];
  controls?: ((stop: StopRow) => ReactNode) | undefined;
}) {
  if (stops.length === 0) {
    return <Empty title="No stops on this route">Add the first address.</Empty>;
  }
  return (
    <Table label="Stops" head={
      <>
        <Th className="text-right">#</Th><Th>Address</Th><Th>Every</Th><Th>Next due</Th>
        <Th className="text-right">Price</Th>{controls ? <Th /> : null}
      </>
    }>
      {stops.map((stop) => (
        <tr key={stop.id} className={stop.active ? undefined : "text-ink-500"}>
          <Td className="text-right tabular-nums">{stop.sequence}</Td>
          <Td>
            {stop.addressLine1}
            {stop.active ? null : <Chip tone="neutral" className="ml-2">Skipped</Chip>}
            {stop.estimatedMinutes === null ? null : (
              <span className="block text-xs text-ink-500">{stop.estimatedMinutes} minutes</span>
            )}
          </Td>
          <Td className="tabular-nums">
            {stop.intervalDays === null
              ? <span className="text-ink-500">Whenever the route runs</span>
              : `${stop.intervalDays} days`}
          </Td>
          <Td className="tabular-nums">
            {stop.nextDueOn ?? <span className="text-ink-500">Next run</span>}
            {stop.lastServicedOn ? (
              <span className="block text-xs text-ink-500">last {stop.lastServicedOn}</span>
            ) : null}
          </Td>
          <Td className="text-right">
            {stop.pricePerStop ? <Money value={stop.pricePerStop} /> : <span className="text-ink-500">&mdash;</span>}
          </Td>
          {controls ? <Td>{controls(stop)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

/**
 * What a materialisation did, which is three numbers and not one.
 *
 * Created, already there, and not due. "Already there" is not an error: a timer
 * runs this, and a retried timer must not put two technicians on one pool. "Not
 * due" is the stop's own cadence, which is why a forty stop route can make a
 * fifteen job day and that is correct.
 */
export function Made({ result }: {
  result: { date: string; created: unknown[]; alreadyThere: number; notDue: { dueOn: string }[] };
}) {
  return (
    <p className="mt-3 text-sm">
      <span className="font-medium">{result.created.length} jobs</span> created for {result.date}.
      {result.alreadyThere > 0 ? ` ${result.alreadyThere} already had one, which is not an error.` : ""}
      {result.notDue.length > 0 ? ` ${result.notDue.length} are not due yet on their own cadence.` : ""}
    </p>
  );
}
