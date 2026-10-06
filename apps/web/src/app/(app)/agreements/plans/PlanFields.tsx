import { Select, TextArea, TextField } from "@/components/ActionForm";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface PlanDefaults {
  name?: string; code?: string | null; description?: string | null;
  price?: string; billingFrequency?: string; termMonths?: number; includedVisitsPerTerm?: number;
  visitAnchorMonths?: number[]; visitAnchorDay?: number | null;
  discountRate?: string | null; priorityDispatch?: boolean; waivesDiagnosticFee?: boolean;
  waivesAfterHoursRate?: boolean; benefits?: string[]; autoRenews?: boolean; renewalNoticeDays?: number;
}

/** "0.150000" as "15", for the box that takes a percentage. */
const percent = (rate: string | null | undefined) =>
  rate && Number(rate) > 0 ? String(Number((Number(rate) * 100).toFixed(4))) : "";

/**
 * THE FIELDS OF A PLAN, for defining one and for editing one.
 *
 * One component so the two forms cannot drift, and each group says beside
 * it who a change reaches, because that is the question an owner editing a
 * plan four hundred people are on actually has.
 */
export function PlanFields({ plan = {}, editing = false }: { plan?: PlanDefaults; editing?: boolean }) {
  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">The plan</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="Name" name="name" required maxLength={200} defaultValue={plan.name ?? ""} className="block sm:col-span-2" />
          <TextField label="Code (optional)" name="code" maxLength={50} defaultValue={plan.code ?? ""} />
        </div>
        <TextArea label="What a member gets, in a sentence (optional)" name="description" rows={2} maxLength={2000}
                  defaultValue={plan.description ?? ""} />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Price and billing</legend>
        {editing ? (
          <p className="text-xs text-ink-500">
            Reaches new sales only. Each member keeps the price and billing they were sold, renewals included,
            until somebody renews them at a new price.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="Price per term" name="price" required inputMode="decimal" placeholder="228.00"
                     defaultValue={plan.price ? String(Number(plan.price).toFixed(2)) : ""} />
          <Select label="Billed" name="billingFrequency" defaultValue={plan.billingFrequency ?? "monthly"} options={[
            { value: "monthly", label: "Monthly" }, { value: "quarterly", label: "Quarterly" },
            { value: "semiannual", label: "Twice a year" }, { value: "annual", label: "Once a year" },
            { value: "one_time", label: "Once, up front" },
          ]} />
          <TextField label="Term in months" name="termMonths" required inputMode="numeric" defaultValue={String(plan.termMonths ?? 12)} />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Visits</legend>
        {editing ? (
          <p className="text-xs text-ink-500">
            Reaches new sales, and each member&apos;s next term when it renews. A term already running owes what it owed.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="Visits included per term" name="includedVisitsPerTerm" inputMode="numeric"
                     defaultValue={String(plan.includedVisitsPerTerm ?? 0)} />
          <TextField label="Day of the month (optional)" name="visitAnchorDay" inputMode="numeric"
                     defaultValue={plan.visitAnchorDay ? String(plan.visitAnchorDay) : ""} placeholder="15" />
        </div>
        <div>
          <p className="text-sm font-medium text-ink-700">Seasonal: the months visits fall in (optional)</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {MONTHS.map((month, i) => (
              <label key={month} className="inline-flex items-center gap-1 text-sm">
                <input type="checkbox" name="visitAnchorMonths" value={String(i + 1)}
                       defaultChecked={(plan.visitAnchorMonths ?? []).includes(i + 1)} />
                {month}
              </label>
            ))}
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Member benefits</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="Discount on work, per cent" name="discountPercent" inputMode="decimal" placeholder="15"
                     defaultValue={percent(plan.discountRate)} />
        </div>
        {editing ? (
          <p className="text-xs text-ink-500">
            The discount reaches new sales only: each member keeps the rate they bought. The three boxes below are
            the company&apos;s standing promise and reach every member the moment they are saved.
          </p>
        ) : null}
        <div className="space-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="priorityDispatch" defaultChecked={plan.priorityDispatch ?? false} />
            Seen first: a member&apos;s unassigned work goes to the top of the board
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="waivesDiagnosticFee" defaultChecked={plan.waivesDiagnosticFee ?? false} />
            No diagnostic fee (the price book item marked as the diagnostic fee comes off in full)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="waivesAfterHoursRate" defaultChecked={plan.waivesAfterHoursRate ?? false} />
            No after hours rate (the item marked as the after hours rate comes off in full)
          </label>
        </div>
        <TextArea label="Other benefits, one per line, for the sale and the member's screen" name="benefits" rows={3}
                  defaultValue={(plan.benefits ?? []).join("\n")} />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Renewing</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="autoRenews" defaultChecked={plan.autoRenews ?? true} />
            Renews on its own at the end of a term, when the member agreed to that
          </label>
          <TextField label="Days of notice before it renews" name="renewalNoticeDays" inputMode="numeric"
                     defaultValue={String(plan.renewalNoticeDays ?? 30)} />
        </div>
      </fieldset>
    </div>
  );
}
