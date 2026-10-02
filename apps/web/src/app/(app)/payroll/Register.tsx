import { Chip, Money } from "@opentradesos/ui";

export interface RegisterData {
  rows: {
    technicianId: string;
    technicianName: string;
    classification: string | null;
    lines: { kind: string; label: string; explanation: string; hours: string | null; rate: string | null; amount: string }[];
    gross: string;
    carriedForward: string;
    warnings: string[];
  }[];
  problems: { technicianId: string; technicianName: string; messages: string[] }[];
  grossTotal: string;
}

/**
 * WHAT EVERY PERSON IS OWED, AND WHY
 *
 * Each line carries its own explanation, because a payroll figure nobody can
 * explain is worse than a wrong one. People the register cannot assemble are
 * listed first, by name, with what is wrong: the export refuses until they
 * are fixed, and a refusal is the wrong place to learn who.
 */
export function Register({ data }: { data: RegisterData }) {
  return (
    <div>
      {data.problems.length > 0 && (
        <section aria-label="Cannot be paid yet" className="mt-4 rounded-md border border-red-600/20 bg-red-tint p-4 text-sm">
          <h2 className="font-semibold text-red-600">Cannot be paid yet</h2>
          <ul className="mt-2 space-y-1">
            {data.problems.map((p) => (
              <li key={p.technicianId}>
                <span className="font-medium">{p.technicianName}</span>: {p.messages.join(" ")}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">Nobody has hours or commission in this period.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {data.rows.map((row) => (
            <section key={row.technicianId} className="rounded-md border border-steel-200 bg-canvas p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium">
                  {row.technicianName}
                  {row.classification && <span className="ml-2 text-xs text-ink-500">{row.classification}</span>}
                </h3>
                <span className="font-mono font-semibold tabular-nums"><Money value={row.gross} /></span>
              </div>
              <table className="mt-2 w-full text-sm">
                <tbody className="divide-y divide-steel-200">
                  {row.lines.map((line, i) => (
                    <tr key={`${line.kind}-${i}`}>
                      <td className="py-1.5 pr-3">
                        {line.label}
                        <span className="block text-xs text-ink-500">{line.explanation}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-right text-ink-700 tabular-nums">
                        {line.hours !== null && <>{Number(line.hours)} h{line.rate !== null && <> × <Money value={line.rate} /></>}</>}
                      </td>
                      <td className="py-1.5 text-right tabular-nums"><Money value={line.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {Number(row.carriedForward) !== 0 && (
                <p className="mt-2 text-xs text-ink-500">
                  <Money value={row.carriedForward} /> of a commission reversal carries to the next period.
                </p>
              )}
              {row.warnings.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {row.warnings.map((w) => <Chip key={w} tone="warning">{w}</Chip>)}
                </div>
              )}
            </section>
          ))}
          <p className="text-right text-sm">
            Gross for the period: <span className="font-mono font-semibold tabular-nums"><Money value={data.grossTotal} /></span>
          </p>
        </div>
      )}
    </div>
  );
}
