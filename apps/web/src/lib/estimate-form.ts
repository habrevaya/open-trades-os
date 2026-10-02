/**
 * AN ESTIMATE'S OPTIONS, FROM THE COMPOSER'S FORM
 *
 * An estimate is one to five options (good, better, best), each a whole
 * scope of work with its own lines, and a line can be optional: priced and
 * shown, outside the option's total until the customer ticks it.
 *
 * `optionKeys` lists the options in screen order and each option's
 * `option.{key}.lineKeys` its lines, so removing a row in the middle never
 * shifts a price onto the wrong line. Empty rows and options with no lines
 * are skipped, and the contract refuses an estimate with nothing in it.
 */
export interface FormOption {
  name: string;
  isRecommended: boolean;
  lines: {
    priceBookItemId?: string;
    name: string;
    quantity: string;
    unitPrice: string;
    discountAmount: string;
    taxable: boolean;
    isOptional: boolean;
  }[];
}

export function optionsFromForm(form: FormData): FormOption[] {
  const get = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const keys = (list: string) => list.split(",").map((k) => k.trim()).filter(Boolean);
  const recommended = get("recommended");
  const options: FormOption[] = [];
  for (const ok of keys(get("optionKeys"))) {
    const lines: FormOption["lines"] = [];
    for (const lk of keys(get(`option.${ok}.lineKeys`))) {
      const at = (field: string) => get(`line.${ok}.${lk}.${field}`);
      const item = at("priceBookItemId");
      const name = at("name");
      if (!item && !name) continue;
      lines.push({
        ...(item ? { priceBookItemId: item } : {}),
        name: name || "Price book item",
        quantity: money(at("quantity")) || "1",
        unitPrice: item ? money(at("unitPrice")) || "0" : money(at("unitPrice")),
        discountAmount: money(at("discountAmount")) || "0",
        taxable: form.get(`line.${ok}.${lk}.taxable`) !== null,
        isOptional: form.get(`line.${ok}.${lk}.optional`) !== null,
      });
    }
    if (lines.length === 0) continue;
    options.push({ name: get(`option.${ok}.name`) || `Option ${options.length + 1}`, isRecommended: recommended === ok, lines });
  }
  return options;
}

function money(typed: string): string {
  return typed.replace(/[$,\s]/g, "");
}

/** "8.25" typed as a percentage is a rate of 0.0825. Empty is no tax. */
export function rateFromPercent(typed: string | undefined): string {
  const clean = (typed ?? "").replace(/[%\s]/g, "");
  if (clean === "") return "0";
  const n = Number(clean);
  if (!Number.isFinite(n)) return clean;
  return String(Math.round(n * 10_000) / 1_000_000);
}
