import { parties } from "@opentradesos/core";

/**
 * THE FORM TO THE CAST
 *
 * The party form posts every role whether or not anybody holds it, because
 * `setParties` replaces the whole list rather than merging into it. So this
 * is where "a role set to Nobody" becomes "a role that is absent", and it is
 * the only place that decision is made.
 *
 * Pulled out of the server action so it can be tested. It is three
 * conditions and an enum, which is exactly the size of thing that looks too
 * obvious to test and silently posts a customer id into an external name.
 */
export interface PartyInput {
  role: parties.PartyRole;
  customerId?: string;
  externalName?: string;
  externalReference?: string;
}

/** What the form calls each field, in one place, so the form and this agree. */
export const fieldNames = (role: string) => ({
  who: `who_${role}`,
  name: `name_${role}`,
  reference: `ref_${role}`,
});

export function partiesFromForm(
  read: (field: string) => string | null,
  customerId: string,
): PartyInput[] {
  const rows: PartyInput[] = [];

  for (const role of parties.PARTY_ROLE_KEYS) {
    const field = fieldNames(role);
    const who = (read(field.who) ?? "").trim();
    // Nobody holds it, so the role is absent. This is also how one is cleared:
    // there is no separate remove, because a remove and a re-save of the rest
    // are the same request when the whole list is replaced.
    if (who !== "customer" && who !== "external") continue;

    const reference = (read(field.reference) ?? "").trim();
    rows.push({
      role,
      ...(who === "customer"
        ? { customerId }
        /**
         * An empty name is passed along rather than dropped. The service
         * refuses a party with nothing in it and says which role it was;
         * skipping the row here would silently discard the role somebody
         * just chose and show them a saved form with it back on Nobody.
         */
        : { externalName: (read(field.name) ?? "").trim() }),
      ...(reference ? { externalReference: reference } : {}),
    });
  }

  return rows;
}
