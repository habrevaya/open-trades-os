"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { booking, ConflictError, NotFoundError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const refresh = () => revalidatePath("/booking");

type Result = { done?: boolean; error?: string };

const caught = async (
  fn: (context: Awaited<ReturnType<typeof ctx>>) => Promise<unknown>,
): Promise<Result> => {
  try {
    await fn(await ctx());
    refresh();
    return { done: true };
  } catch (error) {
    /**
     * The service's own sentence, not a generic failure.
     *
     * Everything this screen can refuse is something the person can fix in
     * the form in front of them: a window that ends before it starts, a day
     * marked open with no hours, a job type already offered. "Could not save"
     * sends them to support for a typo.
     */
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { error: error.message };
    }
    throw error;
  }
};

export async function offerService(_previous: unknown, form: FormData): Promise<Result> {
  const price = String(form.get("displayPrice") ?? "").trim();
  return caught((context) => booking.createService(context, {
    jobTypeId: String(form.get("jobTypeId") ?? ""),
    publicName: String(form.get("publicName") ?? ""),
    ...(String(form.get("publicDescription") ?? "").trim()
      ? { publicDescription: String(form.get("publicDescription")) } : {}),
    /**
     * An empty price is NOT zero. Absent means "we will quote on site",
     * which is honest and converts better than a number the company will not
     * honour. Sending "0" would publish a free service.
     */
    ...(price ? { displayPrice: price } : {}),
    minNoticeHours: Number(form.get("minNoticeHours") ?? 24),
    maxAdvanceDays: Number(form.get("maxAdvanceDays") ?? 60),
    maxPerWindow: Number(form.get("maxPerWindow") ?? 2),
  }));
}

export async function saveWindows(_previous: unknown, form: FormData): Promise<Result> {
  const names = form.getAll("windowName").map(String);
  const starts = form.getAll("windowStart").map(String);
  const ends = form.getAll("windowEnd").map(String);

  const windows = names
    .map((name, i) => ({
      name: name.trim(),
      startsAt: starts[i] ?? "",
      endsAt: ends[i] ?? "",
      /**
       * Every day, for now. Per day selection is a real thing a company
       * wants and is not built: a Saturday morning window is common. Sending
       * all seven is the honest default, because a window the company never
       * restricted should not be silently restricted here.
       */
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    }))
    .filter((w) => w.name !== "" && w.startsAt !== "" && w.endsAt !== "");

  return caught((context) => booking.setWindows(context, { windows }));
}

export async function saveHours(_previous: unknown, form: FormData): Promise<Result> {
  const days = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
    const closed = form.get(`closed-${dayOfWeek}`) === "on";
    const opensAt = String(form.get(`opens-${dayOfWeek}`) ?? "");
    const closesAt = String(form.get(`closes-${dayOfWeek}`) ?? "");
    return {
      dayOfWeek,
      opensAt: closed || !opensAt ? null : opensAt,
      closesAt: closed || !closesAt ? null : closesAt,
      closed,
    };
  });

  return caught((context) => booking.setHours(context, { days }));
}
