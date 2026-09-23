"use server";

import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers } from "@opentradesos/api/services";
import { CustomerCreate } from "@opentradesos/api/contracts";

/**
 * The form posts here, and this validates with the SAME schema the HTTP API
 * uses.
 *
 * Not a second set of rules that happen to agree today. A server action that
 * validates by hand drifts from the contract within a release, and the drift
 * shows up as a record the API would have refused sitting in the database.
 */
export async function createCustomer(_previous: unknown, form: FormData) {
  const user = await requireSetupUser();

  const line1 = String(form.get("line1") ?? "").trim();

  const parsed = CustomerCreate.safeParse({
    type: form.get("type") ?? "residential",
    name: String(form.get("name") ?? "").trim(),
    ...(form.get("email") ? { email: String(form.get("email")).trim() } : {}),
    ...(form.get("phone") ? { phone: String(form.get("phone")).trim() } : {}),
    // The address is optional, and skipped entirely when blank rather than
    // sent as a set of empty strings, which the schema would reject with a
    // message about a postal code the person never typed.
    ...(line1
      ? {
          property: {
            address: {
              line1,
              city: String(form.get("city") ?? "").trim(),
              state: String(form.get("state") ?? "").trim(),
              postalCode: String(form.get("postalCode") ?? "").trim(),
              country: "US",
            },
          },
        }
      : {}),
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: first ? `${first.path.join(".")}: ${first.message}` : "Check the form." };
  }

  const created = await customers.create(
    { actor: user.actor, db: getDb() },
    { ...parsed.data, customerRole: "owner" } as Parameters<typeof customers.create>[1],
  );

  redirect(`/customers/${created.id}`);
}
