import { money, parties } from "@opentradesos/core";

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
  sharePercent?: string;
  shareAmount?: string;
}

/** What the form calls each field, in one place, so the form and this agree. */
export const fieldNames = (role: string) => ({
  who: `who_${role}`,
  name: `name_${role}`,
  reference: `ref_${role}`,
  share: `share_${role}`,
});

/** The select's value for a payer account: a warranty company, a client with a contract. */
export const ACCOUNT = "account:";

/**
 * A share as somebody types it: "70%" is seventy per cent of the job, and
 * a bare number is an amount. Read that way because "70" meaning seventy
 * dollars and "70%" meaning seventy per cent is what anyone typing it means.
 */
export function shareOf(typed: string): { sharePercent?: string; shareAmount?: string } {
  const value = typed.replace(/[$\s]/g, "");
  if (value === "") return {};
  if (value.endsWith("%")) {
    const number = value.slice(0, -1);
    /** Passed on as typed when it is not a number, so the service's refusal names it. */
    if (!/^\d+(\.\d+)?$/.test(number)) return { sharePercent: value };
    return { sharePercent: money.toString(money.divide(money.money(number), "100")) };
  }
  return { shareAmount: value };
}

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
    const account = who.startsWith(ACCOUNT) ? who.slice(ACCOUNT.length) : null;
    if (who !== "customer" && who !== "external" && !account) continue;

    const reference = (read(field.reference) ?? "").trim();
    rows.push({
      role,
      ...(role === "payer" ? shareOf(read(field.share) ?? "") : {}),
      ...(account ? { customerId: account } : who === "customer"
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
