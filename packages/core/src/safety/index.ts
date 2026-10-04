/**
 * SAFETY RECORDS, THE RULES WITHOUT THE DATABASE
 *
 * What a toolbox talk and an incident report must contain to be worth
 * keeping, decided here so the office screen, the phone and the API refuse the
 * same things in the same words.
 *
 * None of it decides whether anything is reportable to an authority. That
 * depends on the jurisdiction, the injury and what a doctor did, and a form
 * that told a contractor "this one does not need reporting" would be the
 * software making a legal call it has no facts for.
 */

export type IncidentKind = "injury" | "near_miss" | "property_damage" | "vehicle" | "environmental" | "other";

export const INCIDENT_KINDS: readonly IncidentKind[] = [
  "injury", "near_miss", "property_damage", "vehicle", "environmental", "other",
];

/** In the words a person reporting one would use. */
export const INCIDENT_KIND_WORDS: Record<IncidentKind, string> = {
  injury: "Somebody was hurt",
  near_miss: "Near miss: nobody was hurt, and somebody could have been",
  property_damage: "Damage to a customer's property",
  vehicle: "A vehicle incident",
  environmental: "A spill or release",
  other: "Something else",
};

export type PersonRole = "injured" | "involved" | "witness";
export const PERSON_ROLES: readonly PersonRole[] = ["injured", "involved", "witness"];
export const PERSON_ROLE_WORDS: Record<PersonRole, string> = {
  injured: "Hurt",
  involved: "Involved",
  witness: "Saw it",
};

/**
 * How far ahead of the server's clock a time may be and still be "now".
 *
 * A phone's clock drifts, and a report sent the moment something happened can
 * arrive stamped a minute ahead. More than this is a mistyped date.
 */
const CLOCK_SLACK_MS = 10 * 60 * 1000;

export interface IncidentDraft {
  kind: IncidentKind;
  occurredAt: Date;
  description: string;
  people: Array<{ name: string; role: PersonRole; injury?: string | null | undefined }>;
}

/**
 * The problems with an incident report, one sentence each, keyed by field.
 *
 * An injury report must name who was hurt. Everything else about an injury
 * can be filled in later by somebody who was not there; who it happened to
 * cannot, and a report without it is the report that cannot be followed up.
 */
export function incidentProblems(draft: IncidentDraft, now: Date): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = [];
  if (draft.description.trim() === "") {
    problems.push({ path: "description", message: "Say what happened, in your own words." });
  }
  if (draft.occurredAt.getTime() > now.getTime() + CLOCK_SLACK_MS) {
    problems.push({ path: "occurredAt", message: "That time has not happened yet." });
  }
  draft.people.forEach((person, index) => {
    if (person.name.trim() === "") {
      problems.push({ path: `people.${index}.name`, message: "Each person needs a name." });
    }
  });
  if (draft.kind === "injury" && !draft.people.some((p) => p.role === "injured")) {
    problems.push({ path: "people", message: "An injury report has to say who was hurt." });
  }
  return problems;
}

/**
 * Whether a talk can be signed now, and the reason when it cannot.
 *
 * Not before it was held, because a signature on a talk that has not happened
 * says the person heard something they have not. Not after the sheet was
 * closed, because a sheet that keeps collecting names after the office closed
 * it is no longer a record of who was in the room.
 */
export function signingRefusal(
  meeting: { heldAt: Date; closedAt: Date | null },
  attendee: { signedAt: Date | null } | null,
  now: Date,
): string | null {
  if (meeting.closedAt) return "This sign in sheet has been closed, so nobody else can sign it.";
  if (meeting.heldAt.getTime() > now.getTime() + CLOCK_SLACK_MS) {
    return "This talk has not happened yet. Sign it once you have been to it.";
  }
  if (!attendee) return "You are not on the list for this talk. Ask whoever ran it to add you.";
  if (attendee.signedAt) return "You have already signed this one.";
  return null;
}

/**
 * The largest drawn signature accepted, in bytes. A finger on a phone screen
 * makes a picture of a few kilobytes; a megabyte is a photograph sent by
 * mistake, and it is refused before it is stored.
 */
export const MAX_SIGNATURE_BYTES = 200_000;
