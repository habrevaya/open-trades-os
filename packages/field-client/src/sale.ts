import {
  approvalPayload, estimatePayload, invoicePayload, lineFromBook, optionProblem, paymentPayload,
  rateFromPercent, typedLine, type DraftOption,
} from "./sales";
import { parseAmount } from "./money";
import type { FieldQueue } from "./queue";
import type { UploadQueue } from "./uploads";
import type { FieldEstimateOption, PriceBookEntry } from "./wire";

/**
 * SELLING ON THE PHONE, WITHOUT THE SCREEN
 *
 * The estimate builder's state and every step of the sale that goes into
 * the queue, kept here so the phone app and the web page build the same
 * sale and both are tested without a phone. The screens draw from these and
 * call them; the figures come from `sales.ts`, which takes them from core.
 *
 * THE ORDER OF THE QUEUE IS THE ORDER OF THE SALE. The signature is kept on
 * the phone and recorded first, then the approval naming it, then the
 * invoice, then the money, each with the next sequence number. The server
 * applies them in that order, so an invoice is never raised against an
 * estimate it has not yet seen approved, and a payment never lands before
 * the invoice it pays.
 */

/**
 * A quantity typed with a thumb, as the decimal string a line stores, or
 * null. Up to two places, because "1.5" of something is a thing and "1.333"
 * is a typo.
 */
export function parseQuantity(typed: string): string | null {
  const text = typed.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return /[1-9]/.test(text) ? text : null;
}

export const OPTION_NAMES = ["Good", "Better", "Best"] as const;
/** Three on the phone, the good, better and best a customer can take in at a kitchen table. */
export const MAX_OPTIONS = 3;

export interface Builder {
  title: string;
  /** As typed, "8.25". Blank for none. */
  taxPercent: string;
  options: DraftOption[];
  /** The option being added to. */
  active: number;
}

export function newBuilder(newId: () => string, title = ""): Builder {
  return { title, taxPercent: "", options: [blankOption(OPTION_NAMES[0], newId)], active: 0 };
}

function blankOption(name: string, newId: () => string): DraftOption {
  return { id: newId(), name, description: "", isRecommended: false, lines: [] };
}

export function addOption(builder: Builder, newId: () => string): Builder {
  if (builder.options.length >= MAX_OPTIONS) return builder;
  const name = OPTION_NAMES.find((n) => !builder.options.some((o) => o.name === n)) ?? `Option ${builder.options.length + 1}`;
  return { ...builder, options: [...builder.options, blankOption(name, newId)], active: builder.options.length };
}

export function removeOption(builder: Builder, index: number): Builder {
  if (builder.options.length <= 1) return builder;
  const options = builder.options.filter((_, i) => i !== index);
  return { ...builder, options, active: Math.min(builder.active, options.length - 1) };
}

export function renameOption(builder: Builder, index: number, name: string): Builder {
  return { ...builder, options: builder.options.map((o, i) => (i === index ? { ...o, name: name.slice(0, 100) } : o)) };
}

/** One recommended at most: choosing one takes it off the others, and choosing it again takes it off. */
export function recommend(builder: Builder, index: number): Builder {
  return {
    ...builder,
    options: builder.options.map((o, i) => ({ ...o, isRecommended: i === index ? !o.isRecommended : false })),
  };
}

function onActive(builder: Builder, change: (option: DraftOption) => DraftOption): Builder {
  return { ...builder, options: builder.options.map((o, i) => (i === builder.active ? change(o) : o)) };
}

/** A price book line on the option being built, or a reason it was not added. */
export function addBookLine(builder: Builder, entry: PriceBookEntry, quantity: string, newId: () => string):
  { ok: true; builder: Builder } | { ok: false; problem: string } {
  const qty = parseQuantity(quantity);
  if (!qty) return { ok: false, problem: "Enter how many, like 1 or 2.5." };
  return { ok: true, builder: onActive(builder, (o) => ({ ...o, lines: [...o.lines, lineFromBook(entry, qty, newId)] })) };
}

/** Something not in the price book, at a price the technician types. */
export function addTypedLine(builder: Builder, name: string, price: string, quantity: string, newId: () => string):
  { ok: true; builder: Builder } | { ok: false; problem: string } {
  if (name.trim() === "") return { ok: false, problem: "Say what it is." };
  const amount = parseAmount(price);
  if (!amount) return { ok: false, problem: "Enter its price, like 45 or 45.50." };
  const qty = parseQuantity(quantity);
  if (!qty) return { ok: false, problem: "Enter how many, like 1 or 2.5." };
  return { ok: true, builder: onActive(builder, (o) => ({ ...o, lines: [...o.lines, typedLine(name, amount, qty, newId)] })) };
}

export function setOptional(builder: Builder, lineId: string, optional: boolean): Builder {
  return {
    ...builder,
    options: builder.options.map((o) => ({ ...o, lines: o.lines.map((l) => (l.id === lineId ? { ...l, isOptional: optional } : l)) })),
  };
}

export function removeLine(builder: Builder, lineId: string): Builder {
  return { ...builder, options: builder.options.map((o) => ({ ...o, lines: o.lines.filter((l) => l.id !== lineId) })) };
}

/** The tax rate as a fraction, or null when what was typed is not a percentage. */
export function builderTaxRate(builder: Builder): string | null {
  return rateFromPercent(builder.taxPercent);
}

/** Why it cannot be shown to the customer yet, or null when it can. */
export function builderProblem(builder: Builder): string | null {
  if (builderTaxRate(builder) === null) return "Enter the sales tax as a percentage, like 8.25, or leave it empty.";
  for (const option of builder.options) {
    const problem = optionProblem(option);
    if (problem) return problem;
  }
  return null;
}

/** What the queue keeps for this estimate. */
export function builderPayload(builder: Builder, visitId: string): Record<string, unknown> {
  return estimatePayload({
    visitId, title: builder.title, taxRate: builderTaxRate(builder) ?? "0", options: builder.options,
  });
}

/* -------------------------------------------------------- into the queue */

/** A drawn signature already on the phone's disk, hashed, waiting to be sent. */
export interface KeptSignature {
  uploadId: string;
  localUri: string;
  byteSize: number;
  contentHash: string;
}

interface Phone { queue: FieldQueue; uploads: UploadQueue }

/** The signature as an upload, recorded before anything that names it. */
async function keep(phone: Phone, visitId: string, signature: KeptSignature, caption: string, at: Date): Promise<void> {
  await phone.uploads.add({
    uploadId: signature.uploadId, visitId, kind: "signature", contentType: "image/png",
    localUri: signature.localUri, byteSize: signature.byteSize, contentHash: signature.contentHash,
    caption, occurredAt: at,
  });
}

/** The estimate the technician built, into the queue. */
export async function recordEstimate(phone: Phone, input: { visitId: string; estimateId: string; builder: Builder }) {
  return phone.queue.enqueue({
    kind: "estimate.create", subjectId: input.estimateId, payload: builderPayload(input.builder, input.visitId),
  });
}

/** The customer's choice: their signature first, then the approval naming it and the figure they saw. */
export async function recordApproval(phone: Phone, input: {
  visitId: string; estimateId: string; option: FieldEstimateOption; ticked: string[];
  signerName: string; signature: KeptSignature; at?: Date | undefined;
}) {
  const at = input.at ?? new Date();
  await keep(phone, input.visitId, input.signature, `Estimate signed by ${input.signerName.trim()}`, at);
  return phone.queue.enqueue({
    kind: "estimate.approve", subjectId: input.estimateId, occurredAt: at,
    payload: approvalPayload({
      visitId: input.visitId, option: input.option, ticked: input.ticked,
      signerName: input.signerName, signatureUploadId: input.signature.uploadId,
    }),
  });
}

export async function recordDecline(phone: Phone, input: { visitId: string; estimateId: string; reason: string }) {
  return phone.queue.enqueue({
    kind: "estimate.decline", subjectId: input.estimateId,
    payload: { visitId: input.visitId, ...(input.reason.trim() ? { reason: input.reason.trim().slice(0, 1000) } : {}) },
  });
}

/** The invoice raised on site, with the customer's signature when they gave it. */
export async function recordInvoice(phone: Phone, input: {
  visitId: string; invoiceId: string; shownTotal: string;
  signerName: string | null; signature: KeptSignature | null; at?: Date | undefined;
} & ({ source: "estimate"; estimateId: string } | { source: "work"; jobLineIds: string[] })) {
  const at = input.at ?? new Date();
  if (input.signature && input.signerName) {
    await keep(phone, input.visitId, input.signature, `Invoice signed by ${input.signerName.trim()}`, at);
  }
  const base = {
    visitId: input.visitId, shownTotal: input.shownTotal,
    signerName: input.signature ? input.signerName : null,
    signatureUploadId: input.signature?.uploadId ?? null,
  };
  return phone.queue.enqueue({
    kind: "invoice.raise", subjectId: input.invoiceId, occurredAt: at,
    payload: input.source === "estimate"
      ? invoicePayload({ ...base, source: "estimate", estimateId: input.estimateId })
      : invoicePayload({ ...base, source: "work", jobLineIds: input.jobLineIds }),
  });
}

/** Cash or a check, with the tip on top, against the invoice it pays. */
export async function recordPayment(phone: Phone, input: {
  visitId: string; method: "cash" | "check"; amount: string; tip: string | null; checkNumber: string | null; invoiceId: string | null;
}) {
  return phone.queue.enqueue({
    kind: "payment.collect", subjectId: input.visitId,
    payload: paymentPayload({
      method: input.method, amount: input.amount, tip: input.tip, checkNumber: input.checkNumber, invoiceId: input.invoiceId,
    }),
  });
}

/** A cash tip the technician kept, for their pay statement. */
export async function recordCashTip(phone: Phone, input: { visitId: string; amount: string; tipId: string }) {
  return phone.queue.enqueue({ kind: "tip.record", subjectId: input.visitId, payload: { tipId: input.tipId, amount: input.amount } });
}
