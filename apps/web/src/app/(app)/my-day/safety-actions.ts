"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { refusalOf } from "@/lib/actions";
import { safety } from "@opentradesos/api/services";

/**
 * A technician signing a toolbox talk from their phone. The line signed is
 * found from who is signed in, never from anything the page sends.
 */
export async function signTalk(input: { meetingId: string; signature: string }): Promise<{ ok: boolean; message: string }> {
  const user = await requireSetupUser();
  try {
    await safety.sign({ actor: user.actor, db: getDb() }, { id: input.meetingId, signature: input.signature });
    revalidatePath("/my-day");
    return { ok: true, message: "Signed. Thank you." };
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) throw error;
    return { ok: false, message: refusal };
  }
}
