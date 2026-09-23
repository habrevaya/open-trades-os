/**
 * WHO IS INVOLVED IN A JOB
 *
 * The seven roles are in the database as an enum with a comment beside each
 * one, which is the right place for them and the wrong place to read them
 * from. A screen offering a role called `bill_to` with no explanation is a
 * screen where every office decides for itself what the difference between
 * "bill to" and "payer" is, and by the second week two people in the same
 * office disagree.
 *
 * So the vocabulary is declared once, here, with what each role MEANS to the
 * person filling it in. Same argument as the job priority scale next door:
 * the label is the cheap part, and the meaning is the part that decides
 * whether the data is worth anything six months later.
 *
 * The order is the order they are asked on a screen, which is roughly the
 * order they are learned: who asked, who is there, who says yes, who pays.
 */
export type PartyRole =
  | "requester" | "site_contact" | "approver" | "bill_to" | "payer" | "referrer" | "owner";

export interface PartyRoleSpec {
  key: PartyRole;
  label: string;
  /** What it means to whoever is filling it in, which is why they are told. */
  meaning: string;
}

export const PARTY_ROLES: PartyRoleSpec[] = [
  {
    key: "requester",
    label: "Requested by",
    meaning: "Who asked for the work, and who to go back to when the scope changes.",
  },
  {
    key: "site_contact",
    label: "On site",
    meaning: "Who is actually at the property. This is the one the technician calls.",
  },
  {
    key: "approver",
    label: "Approves the spend",
    meaning: "Who says yes to the scope and the price. Usually not the one on site.",
  },
  {
    key: "bill_to",
    label: "Billed to",
    meaning: "Who receives the invoice. An invoice addressed to anyone else is refused.",
  },
  {
    key: "payer",
    label: "Pays",
    meaning: "Where the money comes from, which is often not who receives the invoice.",
  },
  {
    key: "referrer",
    label: "Referred by",
    meaning: "Who sent us the work, for attribution and any fee owed on it.",
  },
  {
    key: "owner",
    label: "Owns the property",
    meaning: "Recorded only when that is nobody already named above.",
  },
];

export const PARTY_ROLE_KEYS: PartyRole[] = PARTY_ROLES.map((role) => role.key);

/**
 * A role outside the list is shown rather than swallowed.
 *
 * Same rule as an unknown job priority: the row came from somewhere, and a
 * reader deciding who to call is better served by seeing the raw role than
 * by a blank where a name should be.
 */
export function roleLabel(key: string): string {
  return PARTY_ROLES.find((role) => role.key === key)?.label ?? key.replace(/_/g, " ");
}
