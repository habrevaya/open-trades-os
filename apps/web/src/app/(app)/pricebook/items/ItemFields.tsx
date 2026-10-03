import { TextArea, TextField } from "@/components/ActionForm";

export const KINDS = [
  { value: "service", label: "Service" }, { value: "material", label: "Material" },
  { value: "equipment", label: "Equipment" }, { value: "labor", label: "Labour" },
  { value: "fee", label: "Fee" }, { value: "discount", label: "Discount" },
];

/**
 * Which fee it is, said in the words a member's plan uses. Most items are
 * neither, and that is the first choice.
 */
export const FEE_ROLES = [
  { value: "", label: "Neither" },
  { value: "diagnostic", label: "The diagnostic fee (a plan can waive it)" },
  { value: "after_hours", label: "The after hours rate (a plan can waive it)" },
];

/** The shelf choices, nested by indentation the way the category manager shows them. */
export function shelfOptions(shelves: { id: string; name: string; depth: number }[]) {
  return [{ value: "", label: "No category" }, ...shelves.map((c) => ({
    value: c.id, label: `${"  ".repeat(c.depth)}${c.name}`,
  }))];
}

export interface PriceFieldDefaults {
  name?: string; description?: string | null; price?: string; cost?: string | null;
  taxable?: boolean; taxClass?: string | null; laborMinutes?: number | null; warrantyMonths?: number | null;
}

const two = (value: string | null | undefined) => (value ? String(Number(value).toFixed(2)) : "");

/**
 * The fields that live on a VERSION: what it is called, what it says, what
 * it costs and charges. Shared by creating an item and revising one, so the
 * two cannot ask different questions. Cost is only shown to somebody who may
 * see it, and left out of the form entirely otherwise so a revision cannot
 * blank it.
 */
export function PriceFields({ item = {}, seesCost }: { item?: PriceFieldDefaults; seesCost: boolean }) {
  return (
    <div className="space-y-3">
      <TextField label="Name" name="name" required maxLength={200} defaultValue={item.name ?? ""} />
      <TextArea label="What the customer reads on a proposal" name="description" rows={2} maxLength={5000}
                defaultValue={item.description ?? ""} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Price" name="price" required inputMode="decimal" defaultValue={two(item.price)} />
        {seesCost ? <TextField label="Cost to us" name="cost" inputMode="decimal" defaultValue={two(item.cost)} /> : null}
        <TextField label="Labour minutes" name="laborMinutes" inputMode="numeric"
                   defaultValue={item.laborMinutes == null ? "" : String(item.laborMinutes)} />
        <TextField label="Warranty months" name="warrantyMonths" inputMode="numeric"
                   defaultValue={item.warrantyMonths == null ? "" : String(item.warrantyMonths)} />
        <TextField label="Tax class" name="taxClass" maxLength={50} defaultValue={item.taxClass ?? ""} />
        <label className="flex items-center gap-2 pt-6 text-sm">
          <input type="checkbox" name="taxable" defaultChecked={item.taxable ?? true} /> Taxable
        </label>
      </div>
    </div>
  );
}

