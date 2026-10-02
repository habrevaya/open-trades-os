/**
 * WHERE A PAYMENT GOES, FROM THE FORM
 *
 * One box per open invoice, named `apply.{invoiceId}`. A box left empty or
 * at zero applies nothing to that invoice; whatever the boxes do not
 * account for is held for the customer. Always a list, never omitted:
 * omitting it asks the service to apply oldest balance first, which is a
 * decision the person at the form did not make.
 */
export function allocationsFromForm(form: FormData): { invoiceId: string; amount: string }[] {
  const out: { invoiceId: string; amount: string }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("apply.") || typeof value !== "string") continue;
    const amount = value.replace(/[$,\s]/g, "");
    if (amount === "" || Number(amount) === 0) continue;
    out.push({ invoiceId: name.slice("apply.".length), amount });
  }
  return out;
}

/** The ways money arrives that a person records by hand. A card is confirmed by its processor instead. */
export const METHODS = [
  { value: "check", label: "Cheque" },
  { value: "cash", label: "Cash" },
  { value: "ach", label: "Bank transfer (ACH)" },
  { value: "other", label: "Other" },
] as const;

export const METHOD_LABEL: Record<string, string> = {
  check: "Cheque", cash: "Cash", ach: "Bank transfer", other: "Other", card: "Card",
  card_present: "Card (in person)", financing: "Financing", credit: "Credit",
};
