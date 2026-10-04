import { ActionForm } from "@/components/ActionForm";
import { preferredDaysAction } from "./preferred-days-actions";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * THE DAYS OF THE WEEK THAT SUIT THEM
 *
 * Rebalancing several days may move one of their visits to another of these
 * days, and to no other, and tells them when it does. None ticked is any
 * day, which moves nothing on its own: a visit moves only inside what the
 * customer agreed.
 */
export function PreferredDays({ customerId, days, canWrite }: { customerId: string; days: number[]; canWrite: boolean }) {
  const said = days.length === 0 ? "Any day" : days.map((d) => DAYS[d]).join(", ");
  if (!canWrite) {
    return <p className="mt-4 text-sm text-ink-700"><span className="font-medium">Days that suit them:</span> {said}</p>;
  }
  return (
    <section aria-label="Days that suit them" className="mt-6">
      <h2 className="text-sm font-semibold">Days that suit them</h2>
      <ActionForm action={preferredDaysAction} submit="Save days" tone="quiet" hidden={{ customerId }}
                  className="mt-2 flex flex-wrap items-center gap-3">
        {DAYS.map((name, d) => (
          <label key={name} className="flex items-center gap-1 text-sm">
            <input type="checkbox" name="day" value={d} defaultChecked={days.includes(d)} /> {name}
          </label>
        ))}
      </ActionForm>
      <p className="mt-1 text-xs text-ink-500">
        A visit of theirs may be moved to another of these days when the office rebalances several days, and they are told.
      </p>
    </section>
  );
}
