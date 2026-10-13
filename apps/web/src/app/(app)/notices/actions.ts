"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { attempt, parsed, type FormState } from "@/lib/actions";
import { staffNotices } from "@opentradesos/api/services";
import { readMyNotices } from "@opentradesos/api/contracts";

/**
 * MARKING ONE'S OWN NOTICES READ
 *
 * Only ever the signed in person's own: the service marks rows by the session's
 * person and ignores any id that is not theirs, so nothing posted here can touch
 * somebody else's.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** The bell is in the layout, so every page shows the new count. */
const refresh = () => revalidatePath("/", "layout");

export async function markNoticeRead(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () =>
    staffNotices.markRead(await ctx(), parsed(readMyNotices.input, { ids: [String(form.get("id") ?? "")] })));
  if (state?.done) refresh();
  return state;
}

export async function markAllNoticesRead(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => staffNotices.markRead(await ctx(), { all: true }));
  if (state?.done) refresh();
  return state;
}

/**
 * The bell's own button, a plain form with no answer to show: it works before
 * any JavaScript has loaded, like the rail's collapse button beside it.
 */
export async function markAllNoticesReadFromBell(_form: FormData): Promise<void> {
  await staffNotices.markRead(await ctx(), { all: true });
  refresh();
}
