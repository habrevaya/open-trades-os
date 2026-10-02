import type { ReactNode } from "react";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

/**
 * The shape this screen draws, written out rather than imported from the
 * service, so a case the service cannot produce today can still be rendered in
 * a test: a territory with no codes, one with no travel fee, a retired one.
 */
export interface TerritoryRow {
  id: string;
  name: string;
  postalCodes: string[];
  travelFee: string | null;
  active: boolean;
}

/**
 * WHERE THE COMPANY WORKS, AND WHAT IT COSTS TO GET THERE.
 *
 * Two columns and both of them are load bearing. The codes are what an address
 * is matched against when a property is created, so a code nobody listed is an
 * address in no territory. The travel fee is what is charged for going there,
 * and an empty one is NOT free: it means the company default applies, which is a
 * different fact and is said in words rather than left as a blank cell.
 */
export function Territories({
  rows, control,
}: {
  rows: TerritoryRow[];
  control?: (row: TerritoryRow) => ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <Empty title="No territories yet">
        Until there is one, every address is in no territory: nothing picks up a trip charge and
        nothing can be routed by area. One territory covering every code you work is a fine start.
      </Empty>
    );
  }

  return (
    <Table
      label="Territories"
      head={
        <>
          <Th>Territory</Th>
          <Th>Postal codes</Th>
          <Th className="text-right">Trip charge</Th>
          <Th>State</Th>
          {control ? <Th /> : null}
        </>
      }
    >
      {rows.map((row) => (
          <tr key={row.id}>
            <Td>{row.name}</Td>
            <Td>
              {row.postalCodes.length === 0
                ? <span className="text-ink-500">No codes, so no address matches it</span>
                : <Codes codes={row.postalCodes} />}
            </Td>
            <Td className="text-right">
              {row.travelFee === null
                ? <span className="text-ink-500">Company default</span>
                : <Money value={row.travelFee} />}
            </Td>
            <Td>
              {row.active
                ? <Chip tone="success">In use</Chip>
                : <Chip tone="neutral">Retired</Chip>}
            </Td>
            {control ? <Td>{control(row)}</Td> : null}
          </tr>
      ))}
    </Table>
  );
}

/**
 * The codes, and a count once there are enough that nobody is reading them.
 *
 * A company working ninety codes gets a cell that is a wall of five digit
 * numbers, which is the same as no information. Twelve is roughly where a
 * glance stops working.
 */
const SHOWN = 12;

function Codes({ codes }: { codes: string[] }) {
  const shown = codes.slice(0, SHOWN);
  const rest = codes.length - shown.length;
  return (
    <span className="tnum">
      {shown.join(", ")}
      {rest > 0 ? <span className="text-ink-500">{` and ${rest} more`}</span> : null}
    </span>
  );
}

/** How many addresses this company can place, said as a number not a feeling. */
export function Coverage({ rows }: { rows: TerritoryRow[] }) {
  const live = rows.filter((row) => row.active);
  const codes = new Set(live.flatMap((row) => row.postalCodes));
  const withFee = live.filter((row) => row.travelFee !== null).length;
  return (
    <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
      <Figure label="Territories in use" value={String(live.length)} />
      <Figure label="Postal codes covered" value={String(codes.size)} />
      <Figure
        label="With their own trip charge"
        value={`${withFee} of ${live.length}`}
        note={withFee === live.length ? undefined : "The rest use the company default."}
      />
    </dl>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded border border-steel-200 bg-canvas p-3">
      <dt className="text-sm text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tnum">{value}</dd>
      {note ? <dd className="mt-0.5 text-sm text-ink-500">{note}</dd> : null}
    </div>
  );
}
