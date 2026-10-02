import { WINDOW_HOURS } from "@/lib/visit-window";

export interface TechnicianChoice {
  id: string;
  displayName: string;
  /** On approved time off on the day the form opened for. */
  away?: boolean;
}

/**
 * When a visit happens and who goes.
 *
 * The day, the time the technician can arrive from and how long the arrival
 * window is, which is how the office says it on the phone. Times are the
 * company's wall clock (see lib/visit-window.ts). Technicians are ticked
 * rather than picked from one list, because an install goes out as two.
 *
 * Somebody away today is marked, and still offered: the time off is
 * checked against the day actually chosen when the form is sent, by the
 * service, and refused there in a sentence naming them.
 */
export function VisitFields({
  technicians, defaultDate, optional = false, legend = "Visit",
}: {
  technicians: TechnicianChoice[];
  defaultDate?: string | undefined;
  /** When the whole visit can be left blank, as on a job booked as a lead. */
  optional?: boolean;
  legend?: string;
}) {
  return (
    <fieldset className="space-y-4 rounded-md border border-steel-200 p-4">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      {optional && (
        <p className="text-sm text-ink-500">
          Leave the day empty to book it as a lead and schedule it later.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-4">
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Day</span>
          <input type="date" name="date" defaultValue={defaultDate} required={!optional}
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Arrives from</span>
          <input type="time" name="start" defaultValue="09:00" required={!optional}
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Arrival window</span>
          <select name="windowHours" defaultValue="2"
                  className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
            {WINDOW_HOURS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Expected to take (minutes)</span>
          <input type="number" name="duration" min={5} max={1440} step={5} defaultValue={60}
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
      </div>
      {technicians.length === 0 ? (
        <p className="text-sm text-ink-500">
          Nobody is set up as a technician yet, so this goes on the board unassigned.
        </p>
      ) : (
        <div>
          <span className="text-sm font-medium text-ink-700">Who goes</span>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
            {technicians.map((t) => (
              <label key={t.id} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" name="technicianIds" value={t.id} />
                {t.displayName}
                {t.away ? <span className="text-xs text-amber-700">off today</span> : null}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-500">Nobody ticked puts it on the board unassigned.</p>
        </div>
      )}
    </fieldset>
  );
}
