"use server";

import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { phoneMenus, voice, callQueues, softphone } from "@opentradesos/api/services";
import {
  createPhoneMenu, createRingGroup, createCallQueue, setUpSoftphone, type Destination,
} from "@opentradesos/api/contracts";
import type { z } from "zod";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const refresh = () => revalidatePath("/settings/phone");

/**
 * WHERE A PICKER POINTS, read back from the form.
 *
 * Every destination picker posts `kind:id` (`ring_group:...`, `person:...`,
 * `voicemail:main`, `on_call_rota:company`, `queue:...`, or `agent` for the
 * phone assistant), and "a number outside the
 * company" posts `forward` with the number typed beside it. Parsed by the
 * route's own schema afterwards, so the screen is exactly as strict as the
 * API.
 */
function destination(value: string | undefined, number: string | undefined): z.input<typeof Destination> | null {
  if (!value) return null;
  const [kind, ...rest] = value.split(":");
  const id = rest.join(":");
  switch (kind) {
    case "person": return { kind: "person", userId: id };
    case "ring_group": return { kind: "ring_group", id };
    case "ivr": return { kind: "ivr", menu: id };
    case "on_call_rota": return { kind: "on_call_rota", id: id || "company" };
    case "voicemail": return { kind: "voicemail", box: "main" };
    case "forward": return { kind: "forward", e164: (number ?? "").replace(/[^\d+]/g, "").replace(/^(\d{10})$/, "+1$1") };
    case "queue": return { kind: "queue", id };
    case "agent": return { kind: "agent" };
    default: return null;
  }
}

/** Every value posted under a name, empties KEPT, so rows of a repeated form stay lined up. */
const column = (form: FormData, name: string) => form.getAll(name).map((v) => (typeof v === "string" ? v.trim() : ""));

export async function saveMenu(_previous: FormState, form: FormData): Promise<FormState> {
  const keys = column(form, "optionKey");
  const labels = column(form, "optionLabel");
  const tos = column(form, "optionTo");
  const numbers = column(form, "optionNumber");
  /** A row with nothing in it is a spare row, not an option. */
  const options = keys
    .map((key, i) => ({ key, label: labels[i] ?? "", to: destination(tos[i], numbers[i]) }))
    .filter((row) => row.key !== "" || row.label !== "" || row.to !== null)
    .map((row) => ({ ...row, to: row.to ?? { kind: "voicemail" as const, box: "main" } }));

  const state = await attempt(form, async () => {
    const input = parsed(createPhoneMenu.input, {
      name: field(form, "name") ?? "",
      greeting: field(form, "greeting") ?? "",
      options,
      noInputTo: destination(field(form, "noInputTo"), field(form, "noInputNumber")) ?? { kind: "voicemail", box: "main" },
      afterHoursTo: destination(field(form, "afterHoursTo"), field(form, "afterHoursNumber")),
      timeoutSeconds: Number(field(form, "timeoutSeconds") ?? 6),
    });
    const id = field(form, "id");
    await phoneMenus.saveMenu(await ctx(), { ...input, ...(id ? { id } : {}) });
  });
  refresh();
  return state;
}

export async function saveRingGroup(_previous: FormState, form: FormData): Promise<FormState> {
  const who = column(form, "member");
  const numbers = column(form, "memberNumber");
  const labels = column(form, "memberLabel");
  const members = who
    .map((value, i) => value === "number"
      ? { e164: numbers[i] ?? "", label: labels[i] || undefined }
      : value ? { userId: value } : null)
    .filter((m): m is NonNullable<typeof m> => m !== null && !("e164" in m && m.e164 === ""));

  const state = await attempt(form, async () => {
    const input = parsed(createRingGroup.input, {
      name: field(form, "name") ?? "",
      strategy: field(form, "strategy") ?? "all_at_once",
      ringSeconds: Number(field(form, "ringSeconds") ?? 20),
      members,
      noAnswerTo: destination(field(form, "noAnswerTo"), field(form, "noAnswerNumber")) ?? { kind: "voicemail", box: "main" },
    });
    const id = field(form, "id");
    await phoneMenus.saveRingGroup(await ctx(), { ...input, ...(id ? { id } : {}) });
  });
  refresh();
  return state;
}

export async function deleteMenu(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => phoneMenus.deleteMenu(await ctx(), field(form, "id") ?? ""));
  refresh();
  return state;
}

export async function deleteRingGroup(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => phoneMenus.deleteRingGroup(await ctx(), field(form, "id") ?? ""));
  refresh();
  return state;
}

export async function setAnsweringPhone(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await phoneMenus.setAnsweringPhone(await ctx(), {
      userId: field(form, "userId") ?? "",
      e164: field(form, "e164") ?? null,
    });
  });
  refresh();
  return state;
}

/** Which menu answers a number, and whether whoever answers hears what was pressed. */
export async function setNumberMenu(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await voice.handlers.setNumberRouting(await ctx(), {
      id: field(form, "id") ?? "",
      menuId: field(form, "menuId") ?? null,
      whisper: form.get("whisper") === "on",
    });
  });
  refresh();
  return state;
}

export async function answerHere(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => voice.answerHere(await ctx(), { id: field(form, "id") ?? "" }));
  refresh();
  return state;
}

export async function stopAnswering(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => voice.stopAnswering(await ctx(), { id: field(form, "id") ?? "" }));
  refresh();
  return state;
}

/** A waiting line, new or changed, parsed by the route's own schema. */
export async function saveQueue(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const input = parsed(createCallQueue.input, {
      name: field(form, "name") ?? "",
      ringGroupId: field(form, "ringGroupId") ?? "",
      maxWaitSeconds: Number(field(form, "maxWaitSeconds") ?? 300),
      announcePosition: form.get("announcePosition") === "on",
      holdMusicUrl: field(form, "holdMusicUrl") ?? null,
      overflowTo: destination(field(form, "overflowTo"), field(form, "overflowNumber")) ?? { kind: "voicemail", box: "main" },
    });
    const id = field(form, "id");
    await callQueues.saveQueue(await ctx(), { ...input, ...(id ? { id } : {}) });
  });
  refresh();
  return state;
}

export async function deleteQueue(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => callQueues.deleteQueue(await ctx(), field(form, "id") ?? ""));
  refresh();
  return state;
}

/** Browser calling, set up or changed on the company's own Twilio account. */
export async function setUpBrowserCalling(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const input = parsed(setUpSoftphone.input, {
      apiKeySid: field(form, "apiKeySid") ?? "",
      apiKeySecretRef: field(form, "apiKeySecretRef") ?? "",
      callerIdNumberId: field(form, "callerIdNumberId") ?? "",
    });
    await softphone.setup(await ctx(), input);
  });
  refresh();
  return state;
}
