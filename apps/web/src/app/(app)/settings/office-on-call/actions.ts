"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { officeOnCall } from "@opentradesos/api/services";
import { addOfficeOnCallTurn, setOfficeOnCallKinds } from "@opentradesos/api/contracts";
import { notices } from "@opentradesos/core";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/settings/office-on-call");
  revalidatePath("/me");
}

/** Which of the three kinds go to whoever is on call: one box each, all saved at once. */
export async function saveOnCallKinds(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const input = parsed(setOfficeOnCallKinds.input, {
      kinds: notices.ON_CALL_KINDS.filter((kind) => form.get(kind) === "on"),
    });
    const saved = await officeOnCall.setKinds(await ctx(), input);
    return {
      message: saved.kinds.some((k) => k.on)
        ? "Saved. The ticked notices go to whoever is on call, or to everybody when nobody is."
        : "Saved. Every one of these notices goes to everybody who handles it.",
    };
  });
  refresh();
  return state;
}

/** A person on call from a first to a last day. */
export async function addOnCallTurn(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const input = parsed(addOfficeOnCallTurn.input, {
      userId: field(form, "userId") ?? "",
      startsOn: field(form, "startsOn") ?? "",
      endsOn: field(form, "endsOn") || field(form, "startsOn") || "",
      note: field(form, "note") ?? null,
    });
    const turn = await officeOnCall.addTurn(await ctx(), input);
    return { message: `${turn.name} is on call from ${turn.startsOn} to ${turn.endsOn}.` };
  });
  refresh();
  return state;
}

export async function removeOnCallTurn(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await officeOnCall.removeTurn(await ctx(), { id: field(form, "id") ?? "" });
  });
  refresh();
  return state;
}
