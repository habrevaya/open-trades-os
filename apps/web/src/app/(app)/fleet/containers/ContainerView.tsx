import type { ReactNode } from "react";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

/**
 * The shapes this screen draws, written out rather than imported from the
 * service, because a presentational component that depends on a row type cannot
 * be given a case the service has not produced yet, and the cases worth testing
 * here are exactly those: a can with no hire, a hire with no rate, a report with
 * no fleet.
 */
export interface ContainerRow {
  id: string;
  assetType: string;
  identifier: string;
  size: string | null;
  status: string;
  currentAddress: string | null;
  active: boolean;
}

export interface HireRow {
  id: string;
  assetIdentifier: string | null;
  assetSize: string | null;
  propertyAddress: string | null;
  deliveredAt: string | null;
  pickedUpAt: string | null;
  open: boolean;
  daysSoFar: number | null;
  includedDays: number | null;
  dailyRate: string | null;
  weightTons: string | null;
  includedTons: string | null;
  disposalTicketNumber: string | null;
  previousRentalId: string | null;
  /** The collection the scheduler booked, and the invoice it went on, when either has happened. */
  collectionVisitId?: string | null;
  invoiceId?: string | null;
}

export interface Report {
  from: string;
  to: string;
  windowDays: number;
  utilisationRate: string | null;
  rentedDays: number;
  availableDays: number;
  outOfServiceUnits: number;
  averageDurationDays: string | null;
  rentalsEnded: number;
  averageTonsPerHaul: string | null;
  haulsWithTicket: number;
  haulsWithoutTicket: number;
  overageCaptureRate: string | null;
  exceededRentals: number;
  billableRentals: number;
}

const STATUS_TONE: Record<string, "success" | "info" | "danger" | "neutral"> = {
  available: "success",
  on_site: "info",
  out_of_service: "danger",
};

const STATUS_LABEL: Record<string, string> = {
  available: "In the yard",
  on_site: "On a site",
  out_of_service: "Out for repair",
};

/**
 * THE FLEET NUMBERS, AND WHAT EACH ONE IS MADE OF
 *
 * Four figures, each with its two halves under it, for the same reason the trade
 * scorecard shows them: a utilisation rate on its own is a number somebody
 * either believes or does not, and "412 rented days out of 600 available" is one
 * they can check against the board.
 *
 * A null is "nothing to measure", never zero. An empty fleet is not nought per
 * cent utilised and a month with no hauls has no average tonnage, and reporting
 * either as zero would send an owner looking for a problem in a report that is
 * working correctly.
 */
export function Numbers({ report }: { report: Report }) {
  const figures: { label: string; value: string | null; suffix?: string; of: string }[] = [
    {
      label: "Utilisation", value: report.utilisationRate, suffix: "%",
      of: `${report.rentedDays} rented days of ${report.availableDays} available`
        + `${report.outOfServiceUnits > 0 ? `, ${report.outOfServiceUnits} out for repair` : ""}`,
    },
    {
      label: "Average hire", value: report.averageDurationDays, suffix: " days",
      of: `${report.rentalsEnded} ${report.rentalsEnded === 1 ? "hire" : "hires"} ended in the window`,
    },
    {
      label: "Tons per haul", value: report.averageTonsPerHaul,
      of: `${report.haulsWithTicket} with a scale ticket`
        + `${report.haulsWithoutTicket > 0 ? `, ${report.haulsWithoutTicket} without one` : ""}`,
    },
    {
      label: "Overage captured", value: report.overageCaptureRate, suffix: "%",
      of: `${report.billableRentals} billable of ${report.exceededRentals} that went over`,
    },
  ];
  return (
    <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {figures.map((figure) => (
        <li key={figure.label} className="rounded-md border border-steel-200 bg-canvas p-4">
          <p className="text-sm font-medium">{figure.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {figure.value === null
              ? <span className="text-base font-normal text-ink-500">Nothing to measure</span>
              : `${figure.value}${figure.suffix ?? ""}`}
          </p>
          <p className="mt-1 text-xs text-ink-500">{figure.of}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The register: every unit, its number, its size, and where it is.
 *
 * The number painted on the side is the first column because it is what a driver
 * reads out over the radio and what a scale ticket carries. A can out for repair
 * is in this list, marked, because it is the one thing that changes the
 * utilisation denominator and an owner looking at a low rate needs to see it.
 */
export function Register({
  containers, controls,
}: {
  containers: ContainerRow[];
  controls?: ((container: ContainerRow) => ReactNode) | undefined;
}) {
  if (containers.length === 0) {
    return (
      <Empty title="No containers yet">
        Put one on the register with its number and its size, and the fleet report starts counting
        it the same day.
      </Empty>
    );
  }
  return (
    <Table label="The register"
           head={<><Th>Number</Th><Th>Kind</Th><Th>Where</Th>{controls ? <Th /> : null}</>}>
      {containers.map((container) => (
        <tr key={container.id}>
          <Td>
            <span className="font-mono font-medium">{container.identifier}</span>
            {container.size ? <span className="ml-2 text-ink-700">{container.size}</span> : null}
          </Td>
          <Td className="text-ink-700">{kind(container.assetType)}</Td>
          <Td>
            <Chip tone={STATUS_TONE[container.status] ?? "neutral"}>
              {STATUS_LABEL[container.status] ?? container.status}
            </Chip>
            {container.currentAddress ? (
              <span className="ml-2">{container.currentAddress}</span>
            ) : null}
          </Td>
          {controls ? <Td>{controls(container)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

/**
 * The hires, open ones first.
 *
 * Days is `daysSoFar` and the column says so, because for an open hire it is
 * counted to today and changes every midnight. A column headed "Days" with a
 * number that moves is the one somebody copies onto an invoice.
 *
 * A swap says it is one, because without that a four week hire with three swaps
 * reads as four unrelated week long rentals and the average duration comes out
 * at a quarter of the truth.
 */
export function Hires({
  hires, controls,
}: {
  hires: HireRow[];
  controls?: ((hire: HireRow) => ReactNode) | undefined;
}) {
  if (hires.length === 0) {
    return <Empty title="Nothing out on hire">A delivery opens a hire and puts the can on a site.</Empty>;
  }
  return (
    <Table label="Out on hire" head={
      <>
        <Th>Can</Th><Th>Where</Th><Th>Out since</Th>
        <Th className="text-right">Days so far</Th><Th>Ticket</Th>{controls ? <Th /> : null}
      </>
    }>
      {hires.map((hire) => (
        <tr key={hire.id} className={hire.open ? undefined : "text-ink-500"}>
          <Td>
            <span className="font-mono font-medium">{hire.assetIdentifier ?? "a container"}</span>
            {hire.assetSize ? <span className="ml-2">{hire.assetSize}</span> : null}
            {hire.previousRentalId ? <Chip tone="neutral" className="ml-2">Swap</Chip> : null}
          </Td>
          <Td>{hire.propertyAddress ?? "a property"}</Td>
          <Td className="tabular-nums">{day(hire.deliveredAt)}</Td>
          <Td className="text-right tabular-nums">
            {hire.daysSoFar === null ? "" : hire.daysSoFar}
            {hire.includedDays === null ? null : (
              <span className="text-ink-500"> of {hire.includedDays}</span>
            )}
            {/*
              Over its included period, said on the row. An operator finds this
              out today by reading two columns and doing the subtraction, which
              is why unbilled days are the leak this trade is known for.
            */}
            {overdue(hire) ? <Chip tone="warning" className="ml-2">Over</Chip> : null}
          </Td>
          <Td>
            {hire.disposalTicketNumber
              ? <span className="font-mono text-xs">{hire.disposalTicketNumber}</span>
              : hire.open
                ? <span className="text-ink-500">Still out</span>
                : <span className="text-amber-700">No ticket</span>}
            {hire.weightTons ? <span className="ml-2 tabular-nums">{hire.weightTons} t</span> : null}
          </Td>
          {controls ? <Td>{controls(hire)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

/** What this hire owes beyond its quoted price, as two separate meters. */
export interface MeterLine {
  meter: "rental_days" | "disposal_tons";
  overBy: string;
  rate: string;
  amount: string;
}

export function Overage({
  days, lines, total,
}: {
  days: number;
  lines: MeterLine[];
  total: string;
}) {
  return (
    <div className="mt-3 rounded-md border border-steel-200 bg-canvas p-4">
      <p className="text-sm text-ink-700">{days} container {days === 1 ? "day" : "days"}.</p>
      {lines.length === 0 ? (
        <p className="mt-2 text-sm">Nothing beyond what was quoted.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {/*
            TWO METERS, LISTED SEPARATELY and never summed into one line. An
            operator disputing a figure needs the days and the tons apart,
            because one is a scheduling argument and the other is a scale ticket,
            and a single total cannot show either.
          */}
          {lines.map((line) => (
            <li key={line.meter} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{meter(line.meter)}</span>
              <span className="text-ink-700">
                {line.overBy} over, at <Money value={line.rate} />
              </span>
              <span className="ml-auto"><Money value={line.amount} /></span>
            </li>
          ))}
          <li className="flex items-baseline justify-between border-t border-steel-200 pt-1 font-medium">
            <span>Total</span><Money value={total} />
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * Over its included period. Open hires included, because that is when somebody
 * can still do something about it.
 */
const overdue = (hire: HireRow) =>
  hire.includedDays !== null && hire.daysSoFar !== null && hire.daysSoFar > hire.includedDays;

const KIND: Record<string, string> = {
  roll_off_container: "Roll off",
  portable_toilet: "Portable toilet",
  storage_container: "Storage",
};
const kind = (value: string) =>
  KIND[value] ?? value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const METER: Record<string, string> = {
  rental_days: "Extra days",
  disposal_tons: "Extra tonnage",
};
const meter = (value: string) => METER[value] ?? value;

/** A date without a time, because a hire is counted in calendar days. */
const day = (iso: string | null) => (iso === null ? "" : iso.slice(0, 10));
