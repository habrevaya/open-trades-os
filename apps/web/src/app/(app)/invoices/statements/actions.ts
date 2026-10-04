"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { deliverySchedules } from "@opentradesos/api/services";
import { attempt, field } from "@/lib/actions";

/** Turn monthly statements on or off, with when and above what. */
export async function setMonthlyStatements(_previous: unknown, form: FormData) {
  const user = await requireSetupUser();
  const day = field(form, "dayOfMonth");
  const time = field(form, "time");
  const minimum = field(form, "minimumBalance");
  const result = await attempt(form, () => deliverySchedules.setStatementSchedule({ actor: user.actor, db: getDb() }, {
    enabled: form.get("enabled") === "on",
    textWhenPreferred: form.get("textWhenPreferred") === "on",
    ...(day ? { dayOfMonth: Number(day) } : {}),
    ...(time ? { time } : {}),
    ...(minimum ? { minimumBalance: minimum.replace(/^\$/, "") } : {}),
  }));
  revalidatePath("/invoices/statements");
  return result;
}
