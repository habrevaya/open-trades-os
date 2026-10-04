"use server";

import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { softphone, ConflictError } from "@opentradesos/api/services";

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
