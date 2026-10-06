import { rateFromPercent } from "./estimate-form";

/**
 * A PLAN FROM THE PLAN FORM, in the shape `POST /v1/agreement-plans` and its
 * edit take.
 *
 * The discount is typed as a percentage, because that is how an owner says
 * it, and handed over as the fraction the contract takes: 15 becomes 0.15.
 * The visit months are ticked boxes, the benefits one per line. Pure, so the
 * reading is tested without a server.
 */
export interface PlanFormValues {
  name: string;
  code?: string;
  description?: string;
  price: string;
  billingFrequency: string;
  termMonths: number;
  includedVisitsPerTerm: number;
  visitAnchorMonths: number[];
  visitAnchorDay?: number | null;
  discountRate: string;
  priorityDispatch: boolean;
  waivesDiagnosticFee: boolean;
  waivesAfterHoursRate: boolean;
  benefits: string[];
  autoRenews: boolean;
  renewalNoticeDays: number;
  discountExclusions: { categoryIds: string[]; itemIds: string[] };
  /** Null is the company's own figure; absent leaves it as it is. */
  memberHoldPercent?: number | null;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const whole = (form: FormData, name: string, fallback: number) => {
  const raw = text(form, name);
  return raw === "" ? fallback : Number(raw);
};

export function planFromForm(form: FormData, { editing = false }: { editing?: boolean } = {}): PlanFormValues {
  const code = text(form, "code");
  const description = text(form, "description");
  const day = text(form, "visitAnchorDay");
  return {
    name: text(form, "name"),
    ...(code || editing ? { code } : {}),
    ...(description || editing ? { description } : {}),
    price: text(form, "price").replace(/[$,\s]/g, ""),
    billingFrequency: text(form, "billingFrequency") || "monthly",
    termMonths: whole(form, "termMonths", 12),
    includedVisitsPerTerm: whole(form, "includedVisitsPerTerm", 0),
    visitAnchorMonths: form.getAll("visitAnchorMonths").map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b),
    ...(day !== "" ? { visitAnchorDay: Number(day) } : editing ? { visitAnchorDay: null } : {}),
    discountRate: rateFromPercent(text(form, "discountPercent")),
    priorityDispatch: form.get("priorityDispatch") === "on",
    waivesDiagnosticFee: form.get("waivesDiagnosticFee") === "on",
    waivesAfterHoursRate: form.get("waivesAfterHoursRate") === "on",
    benefits: text(form, "benefits").split("\n").map((b) => b.trim()).filter(Boolean),
    autoRenews: form.get("autoRenews") === "on",
    renewalNoticeDays: whole(form, "renewalNoticeDays", 30),
    discountExclusions: {
      categoryIds: form.getAll("excludedCategoryIds").map(String).filter(Boolean),
      itemIds: form.getAll("excludedItemIds").map(String).filter(Boolean),
    },
    ...(text(form, "memberHoldPercent") !== ""
      ? { memberHoldPercent: Number(text(form, "memberHoldPercent")) }
      : editing ? { memberHoldPercent: null } : {}),
  };
}
