import { formatAmount, parseAmount } from "./money";
import type { FieldQueue } from "./queue";
import type { UploadQueue } from "./uploads";

/**
 * WHAT THE TECHNICIAN PAID FOR THE COMPANY, ON THE PHONE
 *
 * A part from a supply house on their own card, a toll, lunch two hours from
 * home. The amount, the day, what it was for, the job if there was one and a
 * photograph of the receipt go into the queue as one `expense.record` and,
 * after it, the photograph through the hash checked upload path. The office
 * decides later and the answer comes back with the day.
 *
 * ORDER IS THE POINT. The expense is recorded first and the receipt names it,
 * each with the next sequence number, so the server never meets a photograph
 * for an expense it has not seen. Both are on the phone before anything is
 * sent, so a dead battery cannot separate a receipt from the expense it is for.
 *
 * The phone checks what it can with no signal, so a slip is caught in the
 * driveway; the server judges the same rules again and its sentence wins.
 */

export interface ExpenseDraft {
  /** As typed, "42.50" or "$42.50". Empty when the claim is in miles. */
  amount: string;
  /**
   * Miles driven in the person's own vehicle, as typed ("18.4"), when the claim is in miles. The server works it
   * out at the company's rate on `spentOn` and keeps the rate, so the phone never sends an amount for it.
   */
  miles?: string | undefined;
  /** The day it was paid, "2026-10-05". */
  spentOn: string;
  description: string;
  /** The job it was for, or null for the shop. */
  jobId: string | null;
}

export type CheckedExpense =
  | { ok: true; amount: string; miles?: undefined; spentOn: string; description: string; jobId: string | null }
  | { ok: true; miles: string; amount?: undefined; spentOn: string; description: string; jobId: string | null }
  | { ok: false; reason: string };

/** The most miles one claim may be, as the server holds it. */
const MAX_MILES_TENTHS = 20_000n;

/** More than this is a purchase for the office to make, not something to put on a phone. */
const MAX = 10_000_00n;

/** What a person typed, as the figures the queue keeps, or why not in words. */
export function checkExpenseDraft(draft: ExpenseDraft, today: string): CheckedExpense {
  const typedMiles = draft.miles?.trim() ?? "";
  if (typedMiles !== "" && draft.amount.trim() !== "") {
    return { ok: false, reason: "Fill in the miles you drove or what you paid, not both." };
  }
  let paid: { amount: string } | { miles: string };
  if (typedMiles !== "") {
    if (!/^\d+(\.\d)?$/.test(typedMiles)) return { ok: false, reason: "Say the miles driven, to a tenth, like 18 or 18.4." };
    const [whole = "0", tenth = "0"] = typedMiles.split(".");
    const tenths = BigInt(whole) * 10n + BigInt(tenth);
    if (tenths === 0n) return { ok: false, reason: "The miles have to be more than nothing." };
    if (tenths > MAX_MILES_TENTHS) return { ok: false, reason: "That is more than 2000 miles for one claim. Check the number, or ask the office." };
    paid = { miles: `${whole}.${tenth}` };
  } else {
    const amount = parseAmount(draft.amount);
    if (!amount) return { ok: false, reason: "Say what you paid in dollars and cents, like 42.50." };
    const cents = BigInt(amount.replace(".", ""));
    if (cents > MAX) return { ok: false, reason: "That is more than 10,000.00. Ask the office to pay it back another way." };
    paid = { amount };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.spentOn)) return { ok: false, reason: typedMiles !== "" ? "Say the day you drove." : "Say the day you paid it." };
  if (draft.spentOn > today) return { ok: false, reason: "That day has not happened yet." };
  const description = draft.description.trim().replace(/\s+/g, " ");
  if (description === "") return { ok: false, reason: "Say what it was for, so the office knows what it is paying back." };
  if (description.length > 300) return { ok: false, reason: "Say what it was for in a few words." };
  return { ok: true, ...paid, spentOn: draft.spentOn, description, jobId: draft.jobId } as CheckedExpense;
}

/**
 * What a claim is for the screen, the figure first: "$42.50" for an amount paid, "$9.06 (12.5 miles at $0.725 a
 * mile)" for one in miles, and "12.5 miles" while a claim in miles is still on the phone, because the server works
 * out the amount and the phone does not guess at the rate in force on the day.
 */
export function expenseFigure(expense: { amount: string; miles?: string | null | undefined; mileageRate?: string | null | undefined }): string {
  if (!expense.miles) return formatAmount(expense.amount);
  if (expense.amount === "") return `${expense.miles} miles`;
  return `${formatAmount(expense.amount)} (${expense.miles} miles${expense.mileageRate ? ` at $${expense.mileageRate} a mile` : ""})`;
}

/** A receipt photograph already on the phone's disk, hashed, waiting to be sent. */
export interface KeptReceipt {
  uploadId: string;
  localUri: string;
  contentType: string;
  byteSize: number;
  contentHash: string;
}

interface Phone { queue: FieldQueue; uploads: UploadQueue }

/**
 * Record one. `expenseId` is made by the phone, so a retried send records it
 * once. `jobNumber` is only for the screen's own list before the server has
 * the record; the server reads the job from `jobId`.
 */
export async function recordExpense(phone: Phone, input: {
  expenseId: string;
  expense: Extract<CheckedExpense, { ok: true }>;
  jobNumber?: number | null | undefined;
  receipt?: KeptReceipt | undefined;
  at?: Date | undefined;
}) {
  const at = input.at ?? new Date();
  const queued = await phone.queue.enqueue({
    kind: "expense.record",
    subjectId: input.expenseId,
    occurredAt: at,
    payload: {
      /** Miles go as miles: the server works them out at the company's rate on the day of the drive. */
      ...(input.expense.miles !== undefined ? { miles: input.expense.miles } : { amount: input.expense.amount }),
      spentOn: input.expense.spentOn,
      description: input.expense.description,
      ...(input.expense.jobId ? { jobId: input.expense.jobId } : {}),
      ...(input.jobNumber != null ? { jobNumber: input.jobNumber } : {}),
    },
  });
  if (input.receipt) {
    await phone.uploads.add({
      uploadId: input.receipt.uploadId,
      /** For a receipt this names the expense, not a visit. */
      visitId: input.expenseId,
      kind: "receipt",
      contentType: input.receipt.contentType,
      byteSize: input.receipt.byteSize,
      contentHash: input.receipt.contentHash,
      localUri: input.receipt.localUri,
      caption: "Receipt",
      occurredAt: at,
    });
  }
  return queued;
}
