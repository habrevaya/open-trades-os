/**
 * The arithmetic from core's own file, imported by path: the phone app's
 * bundler builds this one file and not the rest of core. See its header.
 */
import {
  priceOnSite, sameAmount, tipChoices, addAmounts, rateFromPercent, memberEligible,
  type OnSiteMember, type PricedTotals,
} from "@opentradesos/core/field-pricing";
import type {
  BillableLine, FieldEstimate, FieldEstimateLine, FieldEstimateOption, MemberTerms, PriceBookEntry,
} from "./wire";

export { sameAmount, tipChoices, addAmounts, rateFromPercent, memberEligible };
export type { PricedTotals };

/**
 * SELLING AND CLOSING ON SITE, ON THE PHONE
 *
 * Good, better and best built from the price book the phone carries, shown
 * to the customer at the figures the server will write, their choice and
 * signature carried back, the invoice raised and paid with a tip. Pure, so
 * the phone app and the web page build the same payloads from the same
 * rules, and so every figure is tested without a phone.
 *
 * EVERY FIGURE IS CORE'S. The totals come from `priceOnSite`, which a test
 * in core holds to the server's own estimate, invoice and member pricing
 * over thousands of documents. The phone never shows a total it worked out
 * some other way, because the customer signs for what the phone shows.
 *
 * NOTHING HERE CARRIES A COST. The price book on the phone has none, and
 * these screens are turned round to face the customer.
 */

/** A line on an option being built on the phone. */
export interface DraftLine {
  id: string;
  priceBookItemId: string | null;
  versionId: string | null;
  name: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  isOptional: boolean;
  itemKind: string | null;
  feeRole: string | null;
}

export interface DraftOption {
  id: string;
  name: string;
  description: string;
  isRecommended: boolean;
  lines: DraftLine[];
}

/** The plan's terms as the pricing reads them. */
export function memberTerms(member: MemberTerms | null | undefined): OnSiteMember | null {
  return member ? {
    rate: member.rate, waivesDiagnosticFee: member.waivesDiagnosticFee, waivesAfterHoursRate: member.waivesAfterHoursRate,
    excludedItemIds: member.excludedItemIds ?? [],
  } : null;
}

/**
 * A price book entry as a line, at the price the phone holds and the version
 * it came from, so the server writes the price the customer was shown. A kit
 * says what it covers.
 */
export function lineFromBook(entry: PriceBookEntry, quantity: string, newId: () => string): DraftLine {
  const covers = (entry.components ?? []).map((c) => `${c.quantity === 1 ? "" : `${c.quantity} x `}${c.name}`);
  const description = [entry.description ?? null, covers.length > 0 ? `Includes ${covers.join(", ")}.` : null]
    .filter(Boolean).join(" ");
  return {
    id: newId(),
    priceBookItemId: entry.id,
    versionId: entry.versionId,
    name: entry.name,
    description: description === "" ? null : description,
    quantity,
    unitPrice: entry.unitPrice,
    taxable: entry.taxable,
    isOptional: false,
    itemKind: entry.kind ?? null,
    feeRole: entry.feeRole ?? null,
  };
}

/** Something not in the book, at a price the technician typed. */
export function typedLine(name: string, unitPrice: string, quantity: string, newId: () => string): DraftLine {
  return {
    id: newId(), priceBookItemId: null, versionId: null, name: name.trim().slice(0, 200), description: null,
    quantity, unitPrice, taxable: true, isOptional: false, itemKind: null, feeRole: null,
  };
}

/** What an option being built comes to, with every optional extra left unticked, as the customer first sees it. */
export function draftTotals(option: DraftOption, member: MemberTerms | null | undefined, taxRate = "0") {
  return priceOnSite(option.lines.map((line) => ({
    quantity: line.quantity, unitPrice: line.unitPrice, taxable: line.taxable, taxRate,
    isOptional: line.isOptional, isSelected: false, itemKind: line.itemKind, feeRole: line.feeRole,
    itemId: line.priceBookItemId,
  })), memberTerms(member));
}

/** Whether an option can be shown to a customer: a name and at least one line that is not optional. */
export function optionProblem(option: DraftOption): string | null {
  if (option.name.trim() === "") return "Give every option a name, like Repair or Replace.";
  if (option.lines.length === 0) return `${option.name.trim()} has nothing on it yet.`;
  if (option.lines.every((l) => l.isOptional)) return `${option.name.trim()} has only optional extras on it.`;
  return null;
}

/**
 * The `estimate.create` payload. Each line carries the item's kind and fee
 * role as well as what the server needs, so the day on the phone can price
 * the estimate the same way before the server has it.
 */
export function estimatePayload(input: {
  visitId: string; title: string; taxRate: string; options: DraftOption[];
}): Record<string, unknown> {
  return {
    visitId: input.visitId,
    ...(input.title.trim() ? { title: input.title.trim().slice(0, 200) } : {}),
    taxRate: input.taxRate,
    options: input.options.map((option) => ({
      id: option.id,
      name: option.name.trim(),
      ...(option.description.trim() ? { description: option.description.trim() } : {}),
      isRecommended: option.isRecommended,
      lines: option.lines.map((line) => ({
        id: line.id,
        ...(line.priceBookItemId ? { priceBookItemId: line.priceBookItemId } : {}),
        ...(line.versionId ? { versionId: line.versionId } : {}),
        name: line.name,
        ...(line.description ? { description: line.description } : {}),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxable: line.taxable,
        isOptional: line.isOptional,
        isSelected: false,
        itemKind: line.itemKind,
        feeRole: line.feeRole,
      })),
    })),
  };
}

/**
 * An estimate built on this phone, as it will look once the server has it:
 * the member's discount on each line, the totals, nothing else changed. Read
 * from the queued operation, so it is on the screen after the app is killed.
 */
export function estimateFromPayload(
  estimateId: string, payload: Record<string, unknown>, member: MemberTerms | null | undefined,
): FieldEstimate {
  const taxRate = typeof payload["taxRate"] === "string" ? payload["taxRate"] : "0";
  const options = Array.isArray(payload["options"]) ? payload["options"] as Array<Record<string, unknown>> : [];
  return {
    id: estimateId,
    number: 0,
    status: "draft",
    title: typeof payload["title"] === "string" ? payload["title"] : null,
    jobId: null,
    selectedOptionId: null,
    signerName: null,
    terms: null,
    options: options.map((option) => {
      const lines = Array.isArray(option["lines"]) ? option["lines"] as Array<Record<string, unknown>> : [];
      const priced = priceOnSite(lines.map((l) => ({
        quantity: String(l["quantity"] ?? "1"), unitPrice: String(l["unitPrice"] ?? "0"),
        taxable: l["taxable"] !== false, taxRate,
        isOptional: l["isOptional"] === true, isSelected: false,
        itemKind: typeof l["itemKind"] === "string" ? l["itemKind"] : null,
        feeRole: typeof l["feeRole"] === "string" ? l["feeRole"] : null,
        itemId: typeof l["priceBookItemId"] === "string" ? l["priceBookItemId"] : null,
      })), memberTerms(member));
      return {
        id: String(option["id"]),
        name: String(option["name"] ?? "Option"),
        description: typeof option["description"] === "string" ? option["description"] : null,
        isRecommended: option["isRecommended"] === true,
        total: priced.totals.total,
        lines: lines.map((l, i) => ({
          id: String(l["id"]),
          name: String(l["name"] ?? "Line"),
          description: typeof l["description"] === "string" ? l["description"] : null,
          quantity: String(l["quantity"] ?? "1"),
          unitPrice: String(l["unitPrice"] ?? "0"),
          discountAmount: priced.lines[i]!.discountAmount,
          memberDiscountAmount: priced.lines[i]!.memberDiscount,
          taxable: l["taxable"] !== false,
          taxRate,
          isOptional: l["isOptional"] === true,
          isSelected: false,
        })),
      };
    }),
  };
}

/**
 * The price book, searched on the phone with no signal: by name, code,
 * description and what a kit contains, best match first.
 */
export function findInPriceBook(entries: readonly PriceBookEntry[], query: string, limit = 12): PriceBookEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [];
  return entries
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const code = (entry.code ?? "").toLowerCase();
      const rest = `${entry.description ?? ""} ${(entry.components ?? []).map((c) => c.name).join(" ")}`.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (code === word) score += 5;
        else if (name.startsWith(word)) score += 3;
        else if (name.includes(word) || code.includes(word)) score += 2;
        else if (rest.includes(word)) score += 1;
        else return { entry, score: -1 };
      }
      return { entry, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map((r) => r.entry);
}

/* ----------------------------------------------------- showing the customer */

/**
 * Recommended first, then the dearest, the order a proposal uses: cheapest
 * first anchors the customer on the cheapest, which defeats the point of
 * offering options.
 */
export function presentationOrder<T extends { total: string; isRecommended: boolean }>(options: readonly T[]): T[] {
  const sorted = [...options].sort((a, b) => compareAmounts(b.total, a.total));
  const recommended = sorted.findIndex((o) => o.isRecommended);
  if (recommended <= 0) return sorted;
  const [pick] = sorted.splice(recommended, 1);
  return [pick!, ...sorted];
}

/** Two decimal strings compared on their digits, never through a float. */
export function compareAmounts(a: string, b: string): number {
  const units = (value: string): bigint => {
    const match = /^(-?)(\d+)(?:\.(\d{0,4}))?/.exec(value.trim());
    if (!match) return 0n;
    const amount = BigInt(match[2]!) * 10_000n + BigInt((match[3] ?? "").padEnd(4, "0") || "0");
    return match[1] === "-" ? -amount : amount;
  };
  const x = units(a);
  const y = units(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * What an option comes to with the extras the customer has ticked, worked
 * out from its lines as priced on the document, which is the figure the
 * server checks their signature against.
 */
export function optionTotal(option: FieldEstimateOption, ticked: readonly string[]): string {
  return priceOnSite(option.lines.map((l: FieldEstimateLine) => ({
    quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: l.discountAmount,
    memberDiscountAmount: l.memberDiscountAmount, taxable: l.taxable, taxRate: l.taxRate,
    isOptional: l.isOptional, isSelected: l.isOptional ? ticked.includes(l.id) : l.isSelected,
  }))).totals.total;
}

/** Whether a customer can still choose on this estimate. */
export function decidable(estimate: Pick<FieldEstimate, "status">): boolean {
  return ["draft", "sent", "viewed", "expired"].includes(estimate.status);
}

/** The `estimate.approve` payload: their choice, their name, their drawn signature and the figure they saw. */
export function approvalPayload(input: {
  visitId: string; option: FieldEstimateOption; ticked: readonly string[];
  signerName: string; signatureUploadId: string;
}): Record<string, unknown> {
  return {
    visitId: input.visitId,
    optionId: input.option.id,
    selectedLineIds: input.option.lines.filter((l) => l.isOptional && input.ticked.includes(l.id)).map((l) => l.id),
    signerName: input.signerName.trim().slice(0, 200),
    signatureUploadId: input.signatureUploadId,
    shownTotal: optionTotal(input.option, input.ticked),
  };
}

/* ---------------------------------------------------------------- invoices */

/**
 * The work an invoice raised on site can bill, priced as the customer will see it, at the
 * visit's sales tax (`visit.tax.rate`): the rate the server's `billing.createIn` charges the
 * same work, from the company's rates, on the lines that are taxable. A server too old to send
 * one charged none. An invoice from a signed option carries the estimate's rate instead.
 */
export function invoiceFromWork(lines: readonly BillableLine[], member: MemberTerms | null | undefined, taxRate = "0") {
  const priced = priceOnSite(lines.map((l) => ({
    quantity: l.quantity, unitPrice: l.unitPrice,
    taxable: l.taxable, taxRate,
    itemKind: l.itemKind, feeRole: l.feeRole, itemId: l.itemId ?? null,
  })), memberTerms(member));
  return {
    lines: lines.map((l, i) => ({
      ...l, memberDiscount: priced.lines[i]!.memberDiscount, lineTotal: priced.lines[i]!.lineTotal, taxAmount: priced.lines[i]!.taxAmount,
    })),
    totals: priced.totals,
  };
}

/** The approved option an invoice copies, as signed, and its total. */
export function invoiceFromEstimate(estimate: FieldEstimate): { option: FieldEstimateOption; lines: FieldEstimateLine[]; total: string } | null {
  if (estimate.status !== "approved" || !estimate.selectedOptionId) return null;
  const option = estimate.options.find((o) => o.id === estimate.selectedOptionId);
  if (!option) return null;
  return {
    option,
    lines: option.lines.filter((l) => !l.isOptional || l.isSelected),
    total: optionTotal(option, option.lines.filter((l) => l.isOptional && l.isSelected).map((l) => l.id)),
  };
}

export function invoicePayload(input: {
  visitId: string; shownTotal: string; signerName: string | null; signatureUploadId: string | null;
} & ({ source: "estimate"; estimateId: string } | { source: "work"; jobLineIds: string[] })): Record<string, unknown> {
  return {
    visitId: input.visitId,
    source: input.source,
    ...(input.source === "estimate" ? { estimateId: input.estimateId } : { jobLineIds: input.jobLineIds }),
    shownTotal: input.shownTotal,
    ...(input.signerName && input.signerName.trim() ? { signerName: input.signerName.trim().slice(0, 200) } : {}),
    ...(input.signatureUploadId ? { signatureUploadId: input.signatureUploadId } : {}),
  };
}

/** A cash or check payment, with the tip on top and the invoice it pays named. */
export function paymentPayload(input: {
  method: "cash" | "check"; amount: string; tip: string | null; checkNumber: string | null; invoiceId: string | null;
}): Record<string, unknown> {
  return {
    method: input.method,
    amount: input.amount,
    ...(input.tip && /[1-9]/.test(input.tip) ? { tipAmount: input.tip } : {}),
    ...(input.method === "check" && input.checkNumber ? { checkNumber: input.checkNumber.trim() } : {}),
    ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
  };
}
