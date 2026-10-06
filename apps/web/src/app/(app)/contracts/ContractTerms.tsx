import { TextField, Select } from "@/components/ActionForm";
import { SLA_ROWS } from "@/lib/contract-forms";

/** The contract's terms as form fields, shared by setting one up and changing it. */
export function ContractTermFields({ values }: {
  values?: {
    startsOn: string | null; endsOn: string | null; defaultNotToExceed: string | null;
    notToExceedAction: "hold" | "warn"; slaTerms: Array<{ kind: string; minutes: number; priority?: string }>;
    invoiceWithinDays: number | null; claimWithinDays: number | null; invoiceFormat: "csv" | "xml" | null;
    purchaseOrderNumber: string | null;
  } | undefined;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Starts" name="startsOn" type="date" defaultValue={values?.startsOn ?? ""} />
        <TextField label="Ends" name="endsOn" type="date" defaultValue={values?.endsOn ?? ""} />
        <TextField label="Their PO number" name="purchaseOrderNumber" defaultValue={values?.purchaseOrderNumber ?? ""} />
        <TextField label="Not to exceed, per job" name="defaultNotToExceed" inputMode="decimal"
                   defaultValue={values?.defaultNotToExceed ? Number(values.defaultNotToExceed).toFixed(2) : ""} />
        <Select label="Over the limit" name="notToExceedAction" defaultValue={values?.notToExceedAction ?? "hold"}
                options={[{ value: "hold", label: "Hold the invoice" }, { value: "warn", label: "Let it through, with a warning" }]} />
        <Select label="Their invoice file" name="invoiceFormat" defaultValue={values?.invoiceFormat ?? ""}
                options={[{ value: "", label: "None, email or link" }, { value: "csv", label: "CSV" }, { value: "xml", label: "XML" }]} />
        <TextField label="Invoice within, days of finishing" name="invoiceWithinDays" inputMode="numeric"
                   defaultValue={values?.invoiceWithinDays ?? ""} />
        <TextField label="Claim within, days of finishing" name="claimWithinDays" inputMode="numeric"
                   defaultValue={values?.claimWithinDays ?? ""} />
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-ink-700">Response times</legend>
        <div className="mt-2 space-y-2">
          {Array.from({ length: SLA_ROWS }, (_, i) => {
            const term = values?.slaTerms[i];
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-3">
                <Select label="Clock" name={`slaKind${i}`} defaultValue={term?.kind ?? ""}
                        options={[{ value: "", label: "None" }, { value: "respond", label: "Respond by (book a visit)" },
                          { value: "arrive", label: "On site by" }, { value: "complete", label: "Finished by" }]} />
                <TextField label="Hours from when the work arrives" name={`slaHours${i}`} inputMode="decimal"
                           defaultValue={term ? String(term.minutes / 60) : ""} />
                <Select label="For" name={`slaPriority${i}`} defaultValue={term?.priority ?? ""}
                        options={[{ value: "", label: "Every job" }, { value: "normal", label: "Normal jobs" },
                          { value: "high", label: "High priority jobs" }, { value: "emergency", label: "Emergencies" }]} />
              </div>
            );
          })}
        </div>
      </fieldset>
    </>
  );
}
