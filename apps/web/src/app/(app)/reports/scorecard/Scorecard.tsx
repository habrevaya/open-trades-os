import type { kpis } from "@opentradesos/api/services";
import { Money } from "@opentradesos/ui";

type Kpi = kpis.KpiResult;

/**
 * HOW A KPI IS SHOWN, WHICH IS AS AN ARITHMETIC
 *
 * The number is big and the two halves are under it, always. "$620" is an
 * assertion and "$186,000 over 300 jobs" is something a contractor can argue
 * with, and arguing with it is how they come to trust it. Every dashboard in
 * this category shows the first and not the second, which is why nobody
 * believes any of them.
 *
 * A null value is "not this window" rather than zero, because the service
 * reports an empty denominator as null on purpose: nought per cent close rate
 * says every estimate was lost, and no estimates presented says there is
 * nothing to measure.
 */
export function Figure({ kpi, records }: {
  kpi: Kpi;
  /**
   * Where the records behind one half open. Each half is a link, as every
   * number on a report is: the list under it adds up to the half clicked.
   */
  records?: ((half: "numerator" | "denominator") => string) | undefined;
}) {
  const open = (half: "numerator" | "denominator", children: React.ReactNode) => records
    ? <a href={records(half)} className="underline underline-offset-2 hover:text-ink-900">{children}</a>
    : children;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{kpi.label}</span>
        {kpi.target ? <span className="text-xs text-ink-500">target {kpi.target}</span> : null}
      </div>

      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {kpi.value === null ? <span className="text-base font-normal text-ink-500">Not this window</span> : show(kpi.format, kpi.value)}
      </p>

      {/*
        The halves, named by the catalogue rather than by this component, so
        the labels cannot drift from the SQL that produced them.
      */}
      {kpi.value === null ? null : (
        <p className="mt-1 text-xs text-ink-500">
          {open("numerator", <>{half(kpi.numeratorMoney, kpi.numerator)} {kpi.numeratorLabel}</>)}
          {" over "}
          {open("denominator", <>{half(kpi.denominatorMoney, kpi.denominator)} {kpi.denominatorLabel}</>)}
        </p>
      )}

      <p className="mt-2 text-xs text-ink-700">{kpi.definition}</p>
    </>
  );
}

/**
 * What a KPI this product cannot compute shows instead, which is the one
 * missing datum rather than the words "not built".
 */
export function Needs({ kpi }: { kpi: Kpi }) {
  return (
    <>
      <p className="text-sm font-medium">{kpi.label}</p>
      <p className="mt-1 text-sm text-ink-700">{kpi.definition}</p>
      <p className="mt-2 text-sm">
        <span className="font-medium text-ink-700">Needs: </span>
        <span className="text-ink-700">{kpi.needs}</span>
      </p>
    </>
  );
}

/**
 * A percentage keeps its sign, money is money, and a duration says its unit.
 *
 * A duration is hours here because every duration a pack declares is: average
 * rental days is counted as a number of days by the fleet report, not here.
 */
function show(format: Kpi["format"], value: string): React.ReactNode {
  switch (format) {
    case "money":
      return <Money value={value} />;
    case "percent":
      return `${value}%`;
    case "duration":
      return `${value} hrs`;
    case "number":
      return value;
  }
}

/**
 * A half is money when the service says it is: the numerator of a money ratio,
 * and both halves of a percentage of two dollar figures. Anything else is a count.
 */
function half(money: boolean, value: string | null): React.ReactNode {
  if (value === null) return null;
  return money ? <Money value={value} /> : value;
}
