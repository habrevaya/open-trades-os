"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { safetyTalks } from "@opentradesos/api/services";
import { createSafetyTalkSchedule } from "@opentradesos/api/contracts";
import { parsed } from "@/lib/actions";

/** The library and the schedule. Every refusal is the service's. */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** The schedules that come round on a named day of the week; the others ignore the day box. */
const WEEKDAY_FREQUENCIES = ["weekly", "every_other_week", "last_weekday_of_month"];

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
      ...(who.startsWith("crew:") ? { crewId: who.slice(5) } : who.startsWith("tech:") ? { technicianId: who.slice(5) } : {}),
      frequency,
      ...(frequency && WEEKDAY_FREQUENCIES.includes(frequency) && weekday !== undefined ? { weekday: Number(weekday) } : {}),
      ...(frequency === "monthly" && monthDay !== undefined ? { monthDay: Number(monthDay) } : {}),
      ...(held !== undefined ? { heldMinutes: held } : {}),
      startsOn: field(form, "startsOn"),
      location: field(form, "location") ?? null,
      ledBy: field(form, "ledBy") ?? null,
    });
    await safetyTalks.createSchedule(await ctx(), input);
    return { message: "On the schedule. The talk is raised on its day with everybody on it." };
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
