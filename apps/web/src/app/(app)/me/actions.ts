"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { attempt, field, parsed, refusalOf, type FormState } from "@/lib/actions";
import { me, timeOff, ConflictError } from "@opentradesos/api/services";
import { addMyEmergencyContact, setMyOnboardingLine } from "@opentradesos/api/contracts";
import { time } from "@opentradesos/core";

/**
 * WHAT A PERSON DOES TO THEIR OWN RECORD
 *
 * Every one of these is the signed in person's own: the services resolve who
 * that is from the session and refuse anything that is not theirs, so nothing
 * posted here can name somebody else.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/me");
  revalidatePath("/me/time-off");
}

export async function addContact(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await me.addContact(await ctx(), parsed(addMyEmergencyContact.input, {
      name: field(form, "name") ?? "",
      relationship: field(form, "relationship") ?? null,
      phone: field(form, "phone") ?? "",
      alternatePhone: field(form, "alternatePhone") ?? null,
    }));
    return { message: "Added." };
  });
  if (state?.done) refresh();
  return state;
}

export async function removeContact(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => me.removeContact(await ctx(), { id: String(form.get("id") ?? "") }));
  if (state?.done) refresh();
  return state;
}

export async function setLine(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await me.setOnboardingLine(await ctx(), parsed(setMyOnboardingLine.input, {
      id: String(form.get("id") ?? ""),
      done: form.get("done") === "true",
      ...(field(form, "note") ? { note: field(form, "note") } : {}),
    }));
  });
  if (state?.done) refresh();
  return state;
}

/** Where the signature came from, kept on it as evidence. */
async function origin() {
  const h = await headers();
  return {
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent") ?? null,
  };
}

export async function signTyped(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await me.sign(await ctx(), {
      requestId: String(form.get("requestId") ?? ""),
      typedName: field(form, "typedName") ?? "",
      ...(await origin()),
    });
    return { message: "Signed. Thank you." };
  });
  if (state?.done) refresh();
  return state;
}

/** Signing with a drawing, from the pad on the page: answered in words either way. */
export async function signDrawn(input: { requestId: string; drawing: string }): Promise<{ ok: boolean; message: string }> {
  try {
    await me.sign(await ctx(), { requestId: input.requestId, drawing: input.drawing, ...(await origin()) });
    refresh();
    return { ok: true, message: "Signed. Thank you." };
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) throw error;
    return { ok: false, message: refusal };
  }
}

/** `13:30` from a time box, as minutes after midnight, or undefined. */
function minutesOf(value: string | undefined): number | undefined {
  const match = value ? /^(\d{2}):(\d{2})$/.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/**
 * Asking for days off, as whole days in the company's own zone: from the
 * start of the first day to the end of the last. Or, when both times are
 * filled in, part of ONE day, from the first time to the second in the same
 * zone: the route takes any two instants, and a screen that took a range of
 * days with hours on the ends would be asking for something nobody means.
 */
export async function requestTimeOff(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const state = await attempt(form, async () => {
    const from = field(form, "from");
    const to = field(form, "to") ?? from;
    if (!from || !to) throw new ConflictError("Choose the first day you want off.");
    if (to < from) throw new ConflictError("The last day is before the first. Put the earlier day first.");
    const zone = user.organizationTimezone;
    const fromTime = field(form, "fromTime");
    const toTime = field(form, "toTime");
    let startsAt = time.startOfDayIn(from, zone);
    let endsAt = time.startOfDayIn(time.nextDay(to), zone);
    if (fromTime || toTime) {
      const begins = minutesOf(fromTime);
      const ends = minutesOf(toTime);
      if (begins === undefined || ends === undefined) {
        throw new ConflictError("For part of a day, say when it starts and when it ends.");
      }
      if (to !== from) {
        throw new ConflictError("Part of a day is for one day. Ask for each day on its own, or ask for whole days.");
      }
      if (ends <= begins) throw new ConflictError("It has to end after it starts.");
      startsAt = time.instantOfLocal(from, begins, zone);
      endsAt = time.instantOfLocal(from, ends, zone);
    }
    await timeOff.request({ actor: user.actor, db: getDb() }, {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      reason: field(form, "reason") ?? null,
    });
    return { message: "Asked. You will see the answer here." };
  });
  if (state?.done) refresh();
  return state;
}

export async function withdrawTimeOff(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await timeOff.withdraw(await ctx(), { id: String(form.get("id") ?? "") });
    return { message: "Taken back." };
  });
  if (state?.done) refresh();
  return state;
}
