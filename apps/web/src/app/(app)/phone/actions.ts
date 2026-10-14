"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { softphone, callTransfers, ConflictError } from "@opentradesos/api/services";
import { transferCall } from "@opentradesos/api/contracts";

/**
 * What the browser phone asks the server for: a pass for this person's
 * browser, and whether they are taking calls here. Both through the same
 * service the API serves, under `call:place`, for the person signed in.
 *
 * Plain data back rather than a form state, because nothing here is a form:
 * the phone calls these on its own, when it is switched on, every minute
 * while it is taking calls, and when its pass is about to run out.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function softphoneToken(): Promise<{ token: string; identity: string } | { problem: string }> {
  try {
    const minted = await softphone.token(await ctx());
    return { token: minted.token, identity: minted.identity };
  } catch (error) {
    if (error instanceof ConflictError) return { problem: error.message };
    return { problem: "The phone could not be switched on. Try again in a moment." };
  }
}

export async function takeCalls(available: boolean): Promise<{ takingCalls: boolean }> {
  return softphone.presence(await ctx(), { available });
}

/**
 * Hold, passing a caller on, and finishing or calling off a warm pass: each
 * through the same service the API serves, for the person signed in, who has
 * to be the one with the caller. The page is read again after each, because
 * where the caller is now is what the page shows.
 */
export async function holdCaller(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => callTransfers.hold(await ctx(), { id: field(form, "id") ?? "" }));
  revalidatePath("/phone");
  return state;
}

/** `to` is `person:{id}`, `ring_group:{id}` or `queue:{id}`, from the list of places. */
export async function passCaller(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const [kind, id] = (field(form, "to") ?? "").split(":");
    const to = kind === "person" ? { kind, userId: id } : { kind, id };
    const input = parsed(transferCall.input, {
      id: field(form, "id") ?? "", to, warm: form.get("warm") === "on",
    });
    await callTransfers.transfer(await ctx(), input);
  });
  revalidatePath("/phone");
  return state;
}

export async function handOver(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => callTransfers.complete(await ctx(), { id: field(form, "id") ?? "" }));
  revalidatePath("/phone");
  return state;
}

export async function callOff(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => callTransfers.cancel(await ctx(), { id: field(form, "id") ?? "" }));
  revalidatePath("/phone");
  return state;
}
