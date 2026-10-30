"use server";

import { attempt, field, refused, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements, ConflictError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function bookVisit(_previous: unknown, form: FormData) {
  let result;
  try {
    result = await agreements.book(await ctx(), {
      agreementVisitId: String(form.get("agreementVisitId") ?? ""),
    });
  } catch (error) {
    // "Somebody else booked that one" is the expected outcome of two people
    // working the owed list at the same moment, not an error to throw at them.
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/agreements");
  redirect(`/jobs/${result.job.id}`);
}

export async function deliverVisit(_previous: unknown, form: FormData) {
  const agreementId = String(form.get("agreementId") ?? "");
  try {
    await agreements.deliver(await ctx(), {
      agreementVisitId: String(form.get("agreementVisitId") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/agreements/${agreementId}`);
  return { done: true };
}

/**
 * The member does not want this one.
 *
 * The reason is required by the service and typed here rather than picked
 * from a list, because the reasons are the whole of why an agreement book
 * churns and a fixed list turns all of them into "other".
 */
export async function skipVisit(_previous: unknown, form: FormData) {
  const agreementId = String(form.get("agreementId") ?? "");
  let result;
  try {
    result = await agreements.skip(await ctx(), {
      agreementVisitId: String(form.get("agreementVisitId") ?? ""),
      reason: String(form.get("reason") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/agreements/${agreementId}`);
  revalidatePath("/agreements");
  return { done: true, stillDeferred: result.stillDeferred };
}

export async function unskipVisit(_previous: unknown, form: FormData) {
  const agreementId = String(form.get("agreementId") ?? "");
  try {
    await agreements.unskip(await ctx(), {
      agreementVisitId: String(form.get("agreementVisitId") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/agreements/${agreementId}`);
  revalidatePath("/agreements");
  return { done: true };
}

export async function billInstalment(_previous: unknown, form: FormData) {
  const agreementId = String(form.get("agreementId") ?? "");
  try {
    await agreements.bill(await ctx(), {
      agreementBillingId: String(form.get("agreementBillingId") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/agreements/${agreementId}`);
  return { done: true };
}

export async function cancelAgreement(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  try {
    const code = String(form.get("reasonCode") ?? "");
    await agreements.cancel(await ctx(), {
      id,
      /** Checked by the service against the list, and refused in words when it is not on it. */
      reasonCode: code as NonNullable<Parameters<typeof agreements.cancel>[1]["reasonCode"]>,
      reason: String(form.get("reason") ?? ""),
      keepThePrepayment: form.get("keepThePrepayment") === "1",
      endPropertyLink: form.get("endPropertyLink") === "1",
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/agreements/${id}`);
  return { done: true };
}

/**
 * Another term, from the agreement screen.
 *
 * The new price box is optional and blank means the agreement's own price,
 * which is the rule the service enforces: a renewal is not the moment a price
 * rise happens without anybody saying so.
 */
export async function renewAgreement(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const renewed = await agreements.renew(await ctx(), { id, price: field(form, "price") });
    return { message: `Renewed. The new term runs to ${renewed.endsOn}.` };
  });
  revalidatePath(`/agreements/${id}`);
  revalidatePath("/agreements/renewals");
  return result;
}

/**
 * Why a plan lapsed, said from the lapsed agreement's own screen. Optional for the office: this is only
 * reached when somebody chooses to say. A move or a sale offers to end their link to the address, and the
 * service refuses a link for anything else.
 */
export async function recordLapseReason(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const code = field(form, "reasonCode") ?? "";
    const saved = await agreements.recordLapseReason(await ctx(), {
      id,
      /** Checked by the service against the list, and refused in words when it is not on it. */
      reasonCode: code as NonNullable<Parameters<typeof agreements.recordLapseReason>[1]["reasonCode"]>,
      reason: field(form, "reason") ?? "",
      endPropertyLink: form.get("endPropertyLink") === "1",
    });
    return { message: saved.endedLinks > 0 ? "Saved. Their link to the address has ended." : "Saved." };
  });
  revalidatePath(`/agreements/${id}`);
  revalidatePath("/agreements/renewals");
  return result;
}

/**
 * Count an ended term's unused visits as earned now: the release the worker makes on the day a term ends,
 * for one term. The service refuses a term that has not ended, in words.
 */
export async function releaseTerm(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const released = await agreements.releaseTerm(await ctx(), { id, termId: field(form, "termId") ?? "" });
    return {
      message: !released.releasedNow ? "That term had already been counted."
        : Number(released.breakageAmount ?? "0") > 0 ? `Counted as earned: ${released.breakageAmount}.` : "Counted. Nothing was left to count.",
    };
  });
  revalidatePath(`/agreements/${id}`);
  return result;
}
