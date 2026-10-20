"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { attempt, field, parsed, refusalOf, type FormState } from "@/lib/actions";
import { me, timeOff, expenses, staffNotices, ConflictError } from "@opentradesos/api/services";
import { addMyEmergencyContact, setMyNoticeSettings, setMyNoticeTexts, setMyOnboardingLine } from "@opentradesos/api/contracts";
import { notices } from "@opentradesos/core";
import { time } from "@opentradesos/core";
import { fileAsBase64 } from "@/lib/local-time";

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

/** Their own address and phone. The whole of it is sent each time, and an empty box clears that part. */
export async function saveOwnContact(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const before = (await me.record(await ctx())).ownContact.changes.length;
    const after = await me.setOwnContact(await ctx(), {
      phone: field(form, "phone") ?? null,
      addressLine1: field(form, "addressLine1") ?? null,
      addressLine2: field(form, "addressLine2") ?? null,
      city: field(form, "city") ?? null,
      state: field(form, "state") ?? null,
      postalCode: field(form, "postalCode") ?? null,
    });
    return { message: after.changes.length === before ? "Nothing was different, so nothing changed." : "Saved. The office can see what changed and when." };
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
 * filled in, from the first time on the first day to the second time on the
 * last day: part of one day when they are the same day, and part of the first
 * and part of the last of a run otherwise ("from 1 PM Monday to noon
 * Wednesday", which is all of Tuesday in between). The route takes any two
 * instants, so this is only how the form says them. One time without the other
 * is refused, because half of a pair is a guess.
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
      /** On one day the end has to come after the start; across days any two times do. */
      if (to === from && ends <= begins) throw new ConflictError("It has to end after it starts.");
      startsAt = time.instantOfLocal(from, begins, zone);
      endsAt = time.instantOfLocal(to, ends, zone);
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

/**
 * Putting in what you paid for the company, with a photograph of the receipt.
 * The service decides every rule (the amount in dollars and cents, a day that
 * has happened, what it was for, a job that exists) and records it as the
 * signed in person's own, waiting for the office.
 */
export async function recordExpense(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const jobNumber = field(form, "jobNumber");
    const receipt = await fileAsBase64(form.get("receipt"));
    const amount = field(form, "amount");
    const miles = field(form, "miles");
    await expenses.record(await ctx(), {
      /** Miles are worked out by the server at the company's rate, so only what was typed is sent. */
      ...(amount ? { amount } : {}),
      ...(miles ? { miles } : {}),
      spentOn: field(form, "spentOn") ?? "",
      description: field(form, "description") ?? "",
      ...(jobNumber ? { jobNumber: Number(jobNumber) } : {}),
      ...(receipt ? { receipt } : {}),
    });
    return { message: "Saved. The office will say yes or no, and you will see it here." };
  });
  if (state?.done) revalidatePath("/me/expenses");
  return state;
}

/** A photograph added to one of your own that the office has not answered yet. */
export async function addReceipt(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const receipt = await fileAsBase64(form.get("receipt"));
    if (!receipt) throw new ConflictError("Choose the photograph first.");
    await expenses.addReceipt(await ctx(), { id: String(form.get("id") ?? ""), receipt });
    return { message: "Added." };
  });
  if (state?.done) revalidatePath("/me/expenses");
  return state;
}

/**
 * Hours of a course they took, with a photograph of the certificate. They wait
 * for the office and are not counted toward a renewal until approved.
 */
export async function logCeHours(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const certificate = await fileAsBase64(form.get("certificate"));
    await me.logOwnContinuingEducation(await ctx(), {
      certificationTypeId: field(form, "certificationTypeId") ?? "",
      completedOn: field(form, "completedOn") ?? "",
      hours: field(form, "hours") ?? "",
      course: field(form, "course") ?? "",
      provider: field(form, "provider") ?? null,
      evidence: field(form, "evidence") ?? null,
      ...(certificate ? { certificate } : {}),
    });
    return { message: "Sent to the office. The hours count once they have looked at the certificate." };
  });
  if (state?.done) refresh();
  return state;
}

export async function withdrawCeHours(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => me.withdrawOwnContinuingEducation(await ctx(), { id: String(form.get("id") ?? "") }));
  if (state?.done) refresh();
  return state;
}

/* ------------------------------------------------------------- notices */

/**
 * Where each kind of notice reaches this person: one box per kind per place,
 * all saved at once. A box left unticked is off. A text box is only offered
 * once texts are on; the service refuses one ticked before that anyway.
 */
export async function saveNoticeSwitches(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await staffNotices.setSwitches(await ctx(), parsed(setMyNoticeSettings.input, {
      kinds: notices.NOTICE_KINDS.map((kind) => ({
        kind,
        inApp: form.get(`${kind}.inApp`) === "on",
        push: form.get(`${kind}.push`) === "on",
        text: form.get(`${kind}.text`) === "on",
        /** Only the kinds that are emailed have the box; for the rest there is nothing to send. */
        ...(notices.isEmailKind(kind) ? { email: form.get(`${kind}.email`) === "on" } : {}),
      })),
    }));
    return { message: "Saved." };
  });
  if (state?.done) revalidatePath("/me");
  return state;
}

/** Texts to their own mobile, on, with the number and the box they ticked, and where they ticked it from. */
export async function turnOnTexts(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const input = parsed(setMyNoticeTexts.input, {
      on: true, mobilePhone: field(form, "mobilePhone") ?? "", agreed: form.get("agreed") === "on",
    });
    await staffNotices.setTexts(await ctx(), { ...input, ipAddress: (await origin()).ipAddress });
    return { message: "Texts are on. Choose below which notices come by text." };
  });
  if (state?.done) revalidatePath("/me");
  return state;
}

/** The person's own daily email of unread notices, on or off. */
export async function setNoticeDigest(_previous: FormState, form: FormData): Promise<FormState> {
  const on = form.get("on") === "true";
  const state = await attempt(form, async () => {
    await staffNotices.setDigest(await ctx(), { on });
    return { message: on ? "The daily email is on. It comes each morning when something is unread." : "The daily email is off." };
  });
  if (state?.done) revalidatePath("/me");
  return state;
}

export async function turnOffTexts(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await staffNotices.setTexts(await ctx(), { on: false, ipAddress: (await origin()).ipAddress });
    return { message: "Texts are off." };
  });
  if (state?.done) revalidatePath("/me");
  return state;
}
