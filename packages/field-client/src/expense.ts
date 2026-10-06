import { parseAmount } from "./money";
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
  /** As typed, "42.50" or "$42.50". */
  amount: string;
  /** The day it was paid, "2026-10-05". */
  spentOn: string;
  description: string;
  /** The job it was for, or null for the shop. */
  jobId: string | null;
}

export type CheckedExpense =
  | { ok: true; amount: string; spentOn: string; description: string; jobId: string | null }
  | { ok: false; reason: string };

/** More than this is a purchase for the office to make, not something to put on a phone. */
const MAX = 10_000_00n;

/** What a person typed, as the figures the queue keeps, or why not in words. */
export function checkExpenseDraft(draft: ExpenseDraft, today: string): CheckedExpense {
  const amount = parseAmount(draft.amount);
  if (!amount) return { ok: false, reason: "Say what you paid in dollars and cents, like 42.50." };
  const cents = BigInt(amount.replace(".", ""));
  if (cents > MAX) return { ok: false, reason: "That is more than 10,000.00. Ask the office to pay it back another way." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.spentOn)) return { ok: false, reason: "Say the day you paid it." };
  if (draft.spentOn > today) return { ok: false, reason: "That day has not happened yet." };
  const description = draft.description.trim().replace(/\s+/g, " ");
  if (description === "") return { ok: false, reason: "Say what it was for, so the office knows what it is paying back." };
  if (description.length > 300) return { ok: false, reason: "Say what it was for in a few words." };
  return { ok: true, amount, spentOn: draft.spentOn, description, jobId: draft.jobId };
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
      amount: input.expense.amount,
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
