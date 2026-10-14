import type { peopleRecords } from "@opentradesos/api/services";
import { formatIn } from "@/lib/dates";

type Record = Awaited<ReturnType<typeof peopleRecords.ownContactWithin>>;

/**
 * WHAT A PERSON CHANGED ABOUT WHERE THEY CAN BE REACHED, AND WHEN
 *
 * One line per save, newest first: the day, who, and for each of the phone and
 * the address what it was and what it is now. Shown to the person on their own
 * record and to the office on theirs, so neither has to take the other's word.
 */
export function OwnContactChanges({ record, timezone }: { record: Record; timezone: string }) {
  if (record.changes.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className="text-sm font-medium text-ink-700">What changed</h3>
      <ul className="mt-1 space-y-2 text-sm" aria-label="Changes to phone and address">
        {record.changes.map((c) => (
          <li key={c.at}>
            <span className="text-ink-500">{formatIn(c.at, timezone)}{c.by ? `, ${c.by}` : ""}</span>
            {c.changes.map((x) => (
              <span key={x.field} className="block">
                {x.field === "phone" ? "Phone" : "Address"}: {x.before} to {x.after}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
