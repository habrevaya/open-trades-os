"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contracts, rateCards, payerDelivery, priceBook } from "@opentradesos/api/services";
import { attempt, field, refused, refusalOf, type FormState } from "@/lib/actions";
import { cardLinesFromText, cardTermsFromForm, slaTermsFromForm } from "@/lib/contract-forms";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const reader = (form: FormData) => (name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
};
const days = (form: FormData, name: string) => {
  const value = field(form, name);
  return value === undefined ? null : Number(value);
};

/** The terms both forms carry: the limit, the clocks and the file the payer takes. */
function termsFrom(form: FormData) {
  return {
    notToExceedAction: (field(form, "notToExceedAction") === "warn" ? "warn" : "hold") as "hold" | "warn",
    slaTerms: slaTermsFromForm(reader(form)),
    invoiceWithinDays: days(form, "invoiceWithinDays"),
    claimWithinDays: days(form, "claimWithinDays"),
    invoiceFormat: (field(form, "invoiceFormat") ?? null) as "csv" | "xml" | null,
    defaultNotToExceed: field(form, "defaultNotToExceed") ?? null,
    purchaseOrderNumber: field(form, "purchaseOrderNumber") ?? null,
    coveredScope: field(form, "coveredScope") ?? null,
  };
}

export async function createContract(_previous: FormState, form: FormData): Promise<FormState> {
  let id = "";
  const result = await attempt(form, async () => {
    const row = await contracts.createContract(await ctx(), {
      customerId: field(form, "customerId") ?? "",
      name: field(form, "name") ?? "",
      contractNumber: field(form, "contractNumber") ?? null,
      startsOn: field(form, "startsOn") ?? null,
      endsOn: field(form, "endsOn") ?? null,
      ...termsFrom(form),
    });
    id = row.id;
  });
  if (result?.error) return result;
  redirect(`/contracts/${id}`);
}

export async function updateContractTerms(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "contractId") ?? "";
  const result = await attempt(form, async () => contracts.updateContract(await ctx(), {
    id,
    startsOn: field(form, "startsOn") ?? null,
    endsOn: field(form, "endsOn") ?? null,
    ...termsFrom(form),
  }));
  revalidatePath(`/contracts/${id}`);
  return result;
}

export async function addSite(_previous: FormState, form: FormData): Promise<FormState> {
  const contractId = field(form, "contractId") ?? "";
  const result = await attempt(form, async () => contracts.addSite(await ctx(), {
    contractId,
    propertyId: field(form, "propertyId") ?? "",
    siteNumber: field(form, "siteNumber") ?? null,
    notToExceed: field(form, "notToExceed") ?? null,
  }));
  revalidatePath(`/contracts/${contractId}`);
  return result;
}

export async function createCard(_previous: FormState, form: FormData): Promise<FormState> {
  const contractId = field(form, "contractId") ?? "";
  const result = await attempt(form, async () => contracts.createRateCard(await ctx(), {
    name: field(form, "name") ?? "",
    contractId,
    authority: field(form, "authority") ?? "contract",
    effectiveFrom: field(form, "effectiveFrom") ?? null,
    effectiveTo: field(form, "effectiveTo") ?? null,
  }));
  revalidatePath(`/contracts/${contractId}`);
  return result;
}

/**
 * The card's price list, pasted. Lines nothing could match are reported
 * back by row number rather than dropped, so a schedule loaded with a typo
 * says which row rather than quietly pricing one item fewer.
 */
export async function setCardLines(_previous: FormState, form: FormData): Promise<FormState> {
  const contractId = field(form, "contractId") ?? "";
  try {
    const context = await ctx();
    const items = (await priceBook.list(context, { limit: 200, includeInactive: false })).data;
    const codes = new Map(items.filter((i) => i.code).map((i) => [String(i.code).toUpperCase(), i.id]));
    const result = await contracts.setRateCardLines(context, {
      rateCardId: field(form, "rateCardId") ?? "",
      lines: cardLinesFromText(String(form.get("lines") ?? ""), codes),
    });
    revalidatePath(`/contracts/${contractId}`);
    return {
      done: true,
      message: result.refused.length === 0
        ? `${result.accepted} ${result.accepted === 1 ? "price" : "prices"} loaded.`
        : `${result.accepted} loaded. Not loaded: ${result.refused.map((r) => `row ${r.row}, ${r.reason}`).join(" ")}`,
    };
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
}

export async function setCardTerms(_previous: FormState, form: FormData): Promise<FormState> {
  const contractId = field(form, "contractId") ?? "";
  try {
    const terms = cardTermsFromForm(reader(form));
    await rateCards.setTerms(await ctx(), { rateCardId: field(form, "rateCardId") ?? "", ...terms });
  } catch (error) {
    const message = refusalOf(error) ?? (error instanceof Error && /percentage/.test(error.message) ? error.message : null);
    if (message === null) throw error;
    return refused(form, message);
  }
  revalidatePath(`/contracts/${contractId}`);
  return { done: true, message: "Saved." };
}

/** A link the payer can keep, listing everything they owe. Shown once, to hand on. */
export async function issuePayerLink(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    const link = await payerDelivery.issuePortalLink(await ctx(), { customerId: field(form, "customerId") ?? "" });
    return {
      message: `A link to ${link.invoiceCount} open ${link.invoiceCount === 1 ? "invoice" : "invoices"}, good until ${link.expiresAt.slice(0, 10)}.`,
      link: link.url,
    };
  });
}
