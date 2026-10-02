/**
 * AN INVOICE'S LINES, FROM THE COMPOSER'S FORM
 *
 * Each row posts its fields under `line.{key}.{field}`, and `lineKeys` lists
 * the keys in the order the rows are on screen, so a row removed in the
 * middle does not shift every line after it onto the wrong price.
 *
 * A row with nothing on it is skipped rather than refused: the composer
 * opens with an empty row, and an invoice is refused for having no lines by
 * the contract, in words, not by a blank row somebody left alone.
 *
 * A price book row sends only the item and the quantity. Its name and price
 * are the book's, so the service is handed placeholders it replaces; a
 * typed price on a linked item would be a price the server ignores, and
 * showing it would be a lie about what the customer will be charged.
 */
export interface FormLine {
  priceBookItemId?: string;
  jobLineId?: string;
  name: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxable: boolean;
}

export function linesFromForm(form: FormData): FormLine[] {
  const get = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const keys = get("lineKeys").split(",").map((k) => k.trim()).filter(Boolean);
  const lines: FormLine[] = [];
  for (const key of keys) {
    const at = (field: string) => get(`line.${key}.${field}`);
    const item = at("priceBookItemId");
    const name = at("name");
    if (!item && !name) continue;
    const jobLineId = at("jobLineId");
    lines.push({
      ...(item ? { priceBookItemId: item } : {}),
      ...(jobLineId ? { jobLineId } : {}),
      name: name || "Price book item",
      quantity: money(at("quantity")) || "1",
      unitPrice: item ? money(at("unitPrice")) || "0" : money(at("unitPrice")),
      discountAmount: money(at("discountAmount")) || "0",
      taxable: form.get(`line.${key}.taxable`) !== null,
    });
  }
  return lines;
}

/** "$1,234.50" as typed reads as 1234.50. Anything else is left for the contract to refuse. */
function money(typed: string): string {
  return typed.replace(/[$,\s]/g, "");
}
