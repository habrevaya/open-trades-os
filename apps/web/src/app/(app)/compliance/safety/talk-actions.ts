"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { safetyTalks } from "@opentradesos/api/services";
import { createSafetyTalkSchedule, updateSafetyTalkSchedule } from "@opentradesos/api/contracts";
import { parsed } from "@/lib/actions";

/** The library and the schedule. Every refusal is the service's. */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** The schedules that come round on a named day of the week; the others ignore the day box. */
const WEEKDAY_FREQUENCIES = ["weekly", "every_other_week", "last_weekday_of_month"];

/** What the "For" choice means: a crew, a person, a preset or defined role, a branch, or everybody. */
function audienceOf(who: string): Record<string, string | boolean> {
  if (who.startsWith("crew:")) return { crewId: who.slice(5) };
  if (who.startsWith("tech:")) return { technicianId: who.slice(5) };
  if (who.startsWith("role:preset:")) return { role: who.slice(12) };
  if (who.startsWith("role:custom:")) return { roleId: who.slice(12) };
  if (who.startsWith("branch:")) return { branchId: who.slice(7) };
  if (who === "everybody") return { everybody: true };
  return {};
}

const minutesOf = (clock: string | undefined): number | undefined => {
  const match = /^(\d{2}):(\d{2})$/.exec(clock ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
};

export async function addTopic(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await safetyTalks.createTopic(await ctx(), { title: field(form, "title") ?? "", body: field(form, "body") ?? "" });
    return { message: "In the library." };
  });
  revalidatePath("/compliance/safety/topics");
  return state;
}

/** New words for a topic. Talks already held keep the words they were held with; the next one raised from it uses these. */
export async function editTopic(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await safetyTalks.updateTopic(await ctx(), {
      id: field(form, "id") ?? "", title: field(form, "title") ?? "", body: field(form, "body") ?? "",
    });
    return { message: "Saved. Talks already held keep the words they were held with." };
  });
  revalidatePath("/compliance/safety/topics");
  return state;
}

export async function setTopicRetired(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await safetyTalks.updateTopic(await ctx(), { id: field(form, "id") ?? "", retired: form.get("retired") === "yes" });
  });
  revalidatePath("/compliance/safety/topics");
  return state;
}

export async function addSchedule(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const who = field(form, "who") ?? "";
    const frequency = field(form, "frequency");
    const weekday = field(form, "weekday");
    const monthDay = field(form, "monthDay");
    const held = minutesOf(field(form, "heldTime"));
    const input = parsed(createSafetyTalkSchedule.input, {
      topicId: field(form, "topicId"),
      ...audienceOf(who),
      frequency,
      ...(frequency && WEEKDAY_FREQUENCIES.includes(frequency) && weekday !== undefined ? { weekday: Number(weekday) } : {}),
      ...(frequency === "monthly" && monthDay !== undefined ? { monthDay: Number(monthDay) } : {}),
      ...(held !== undefined ? { heldMinutes: held } : {}),
      startsOn: field(form, "startsOn"),
      location: field(form, "location") ?? null,
      ledBy: field(form, "ledBy") ?? null,
      skipHolidays: form.get("skipHolidays") === "on",
    });
    await safetyTalks.createSchedule(await ctx(), input);
    return { message: "On the schedule. The talk is raised on its day with everybody on it." };
  });
  revalidatePath("/compliance/safety/schedules");
  return state;
}

/**
 * Change a scheduled talk: its topic, who it is for, the time, where, who leads it, and holidays. It applies from the next
 * talk raised; talks already raised keep what they were given. The audience is always sent whole, because the form always
 * shows one.
 */
export async function changeSchedule(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const held = minutesOf(field(form, "heldTime"));
    const input = parsed(updateSafetyTalkSchedule.input, {
      id: field(form, "id"),
      topicId: field(form, "topicId"),
      ...audienceOf(field(form, "who") ?? ""),
      ...(held !== undefined ? { heldMinutes: held } : {}),
      location: field(form, "location") ?? null,
      ledBy: field(form, "ledBy") ?? null,
      skipHolidays: form.get("skipHolidays") === "on",
    });
    await safetyTalks.updateSchedule(await ctx(), input);
    return { message: "Saved. It applies from the next talk raised. Talks already raised keep what they were given." };
  });
  revalidatePath("/compliance/safety/schedules");
  return state;
}

export async function setScheduleActive(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await safetyTalks.setScheduleActive(await ctx(), { id: field(form, "id") ?? "", active: form.get("active") === "yes" });
  });
  revalidatePath("/compliance/safety/schedules");
  return state;
}
