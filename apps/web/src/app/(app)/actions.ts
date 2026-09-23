"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { RAIL_COOKIE, RAIL_COOKIE_OPTIONS } from "@/lib/rail";

/**
 * Collapse or expand the rail.
 *
 * A form posting to a server action rather than a click handler, so it works
 * with no JavaScript at all, same as the phone menu below it. It costs a
 * round trip, which for a thing somebody does twice a day is the right trade
 * against a preference that silently forgets itself.
 *
 * The next state comes from the form rather than being read and flipped
 * here. Two tabs open on the same rail would otherwise each toggle whatever
 * the other just wrote, and the button would stop matching what it says.
 */
export async function setRail(form: FormData) {
  const next = String(form.get("next") ?? "");
  if (next !== "collapsed" && next !== "expanded") return;

  (await cookies()).set(RAIL_COOKIE, next, RAIL_COOKIE_OPTIONS);
  // The rail is in the layout, so every path renders it.
  revalidatePath("/", "layout");
}
