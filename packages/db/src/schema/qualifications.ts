import { pgTable, pgEnum, uuid, text, boolean, integer, jsonb, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user, technician } from "./tenancy";

/**
 * M24. WHO MAY DO WHAT, AND THE PROOF.
 *
 * WHAT WAS THERE BEFORE THIS FILE. `technician.skills` is an array of opaque
 * strings, `crew.skills` is another one, and `job_type.required_skills` is a
 * third. `services/crews.ts` compares the first against the third by string
 * equality and refuses a crew that is missing one. That refusal is real and
 * it is the only thing in the product that has ever asked whether somebody is
 * qualified, and the answer it gives is a set difference between two lists a
 * dispatcher typed. Nothing anywhere knew that "epa_608" is a federal
 * certification, that it is held by a named person, that it was issued on a
 * date, or that it ran out in March.
 *
 * `technician.licenses` has carried exactly the right shape since the first
 * migration, `{ type, number, expiresOn }[]`, and nothing in this codebase
 * has ever written one. A jsonb array on a person is also the wrong home for
 * it: it cannot be indexed usefully, it cannot be verified by a second
 * person, it has no audit trail of its own, and renewing a licence overwrites
 * the record of the one that was current last year. These two tables replace
 * it. The column is left alone rather than dropped, because dropping a column
 * is a decision about somebody's imported data and this module has no
 * business making it.
 *
 * TWO TABLES, AND THE SPLIT IS THE DESIGN. A certification TYPE is what this
 * company recognises: the thing an authority issues, what work it unlocks,
 * and whether it runs out. A person's certification is one named human
 * holding one of those, with its own dates and its own evidence. Collapsing
 * them into one table per person is what makes "which of our people can take
 * refrigerant work in June" unanswerable without reading every row and
 * parsing a string.
 *
 * WHERE THIS STOPS, AND WHY: THE SEAM WITH M23.
 *
 * A certificate is a document. M23 (documents and compliance) owns documents,
 * their bytes, their expiries and their renewal workflow, and it is being
 * built in parallel with this. There is deliberately NO file column, no
 * storage key and no document id on either table here, because a column
 * pointing at a table that does not exist yet is a dangling reference the
 * database cannot enforce and nothing can read.
 *
 * The evidence for a certification attaches the way every other file in this
 * product attaches: `attachment` carries an `entity_type` and an `entity_id`,
 * `services/files.ts` writes one for any entity, and a certificate is
 * attached with entity_type `person_certification` and the certification's
 * own id. That path exists today, it is the one the field app already uses,
 * and it needs nothing from this file.
 *
 * So the rule this module holds to: THESE TABLES ARE ABOUT THE PERSON AND THE
 * QUALIFICATION. The date it expires, who verified it, and what work it
 * unlocks. Never the bytes.
 */

/**
 * The states a held certification can be put into BY A PERSON.
 *
 * Expiry is deliberately not one of them. A certification that has run out is
 * computed from `expires_on` against the day being asked about, never stored,
 * because a stored flag needs something to flip it and nothing in this product
 * runs nightly over this table. A column saying `expired` that no job ever
 * sets reads as a working feature on every screen and is false from the day
 * after it is written: `test/unwritten-columns.test.ts` exists because of
 * exactly that defect in another table.
 *
 * `suspended` and `revoked` are different from expiry and from each other. A
 * suspended licence may come back; a revoked one is gone and the person is not
 * getting it back by renewing. Both refuse work today and only one of them is
 * a renewal reminder.
 */
export const certificationStatus = pgEnum("certification_status", [
  "active", "suspended", "revoked",
]);

/**
 * WHAT THIS COMPANY RECOGNISES.
 *
 * `grants_skills` is the load bearing column and it is the whole reason this
 * module unblocks anything. The skill strings in `job_type.required_skills`
 * and `crew.skills` stay exactly as they are: this table says which of those
 * strings a certification makes TRUE, so a refusal can move from "this crew is
 * not qualified for epa_608" to "Dana's EPA 608 Universal expired on 3 March".
 *
 * A certification that unlocks nothing is allowed and is not a mistake: a
 * first aid certificate is worth tracking the expiry of without any job type
 * requiring it.
 *
 * NOT A GLOBAL CATALOGUE. Every row is one company's, because the string a
 * company uses for a skill is the string their dispatcher typed, and a shared
 * catalogue would have to guess at the mapping. The trade packs are where a
 * starting set would come from if one is ever wanted.
 */
export const certificationType = pgTable("certification_type", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The company's own short key. "epa_608_universal". */
  code: text("code").notNull(),
  name: text("name").notNull(),
  /** Who issues it. "EPA", "Texas Department of Licensing and Regulation", "NATE". */
  authority: text("authority"),
  /**
   * The skill strings this certification makes true, matched against
   * `job_type.required_skills` by exact equality. Empty is a real state: see
   * the comment above.
   */
  grantsSkills: jsonb("grants_skills").$type<string[]>().notNull().default([]),
  /**
   * Whether it runs out at all. Declared rather than inferred from whether a
   * date was supplied, because "this licence has no expiry" and "nobody typed
   * the expiry in" are opposite facts and a null date cannot tell them apart.
   * The service refuses the mismatch in both directions.
   */
  expires: boolean("expires").notNull().default(true),
  /** Used to fill in an expiry when one is not given at recording time. */
  defaultValidMonths: integer("default_valid_months"),
  /**
   * How long before expiry somebody needs to know. A renewal that takes six
   * weeks of paperwork and thirty days of notice is a lapse, and the lapse is
   * discovered by a dispatcher at eight in the morning.
   */
  renewalLeadDays: integer("renewal_lead_days").notNull().default(60),
  active: boolean("active").notNull().default(true),
  /** What this is, in the operator's words, for the person maintaining it. */
  note: text("note"),
  ...timestamps,
}, (t) => ({
  /**
   * One row per code per company. Two certification types with the same code
   * means the skill a job needs is granted by whichever row was read first,
   * and the two can disagree about whether it expires.
   */
  codeIdx: uniqueIndex("certification_type_code_idx").on(t.organizationId, t.code),
  orgIdx: index("certification_type_org_idx").on(t.organizationId, t.active),
}));

/**
 * ONE PERSON HOLDING ONE CERTIFICATION.
 *
 * RENEWAL IS A NEW ROW, NEVER AN EDIT. "Was Dana certified when they did that
 * job in March" is the question this table answers at a tribunal, and a row
 * whose expiry date is overwritten every two years cannot answer it. The
 * current certification is the one with the furthest expiry; the ones behind
 * it are the record of what was true when the work was done.
 *
 * It points at `technician` rather than at `membership` or `user`, because
 * `technician` is where the existing `skills` array lives and `crew_member`
 * and `visit_assignment` both key off it. A certification on a membership
 * would not be reachable from the crew check without a join nothing else in
 * this schema makes.
 */
export const personCertification = pgTable("person_certification", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  technicianId: uuid("technician_id").notNull().references(() => technician.id, { onDelete: "cascade" }),
  /**
   * Cascaded, and nothing in this module deletes a certification type: a type
   * is deactivated instead, which keeps every holding of it readable. The
   * cascade is therefore unreachable through the API and is what should
   * happen if somebody ever removes a type by hand, because a holding of a
   * certification nobody recognises any more describes nothing.
   */
  certificationTypeId: uuid("certification_type_id").notNull()
    .references(() => certificationType.id, { onDelete: "cascade" }),
  /** The number on the card. Null where the authority issues none. */
  reference: text("reference"),
  issuedOn: date("issued_on"),
  /** Null means it does not expire, and the type has to agree. */
  expiresOn: date("expires_on"),
  status: certificationStatus("status").notNull().default("active"),
  /** Why it was suspended or revoked, in the words of whoever did it. */
  statusReason: text("status_reason"),
  /**
   * SOMEBODY LOOKED AT THE ACTUAL CARD.
   *
   * Separate from the row existing, because the row is usually typed in by an
   * office manager from an email. An unverified certification is not a lie and
   * is not evidence either, and a company being audited is asked which it is.
   */
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifiedByUserId: uuid("verified_by_user_id").references(() => user.id, { onDelete: "set null" }),
  verificationNote: text("verification_note"),
  ...timestamps,
}, (t) => ({
  /**
   * The query the dispatch check runs: everything this person holds.
   */
  personIdx: index("person_certification_person_idx").on(t.organizationId, t.technicianId),
  /** The renewal calendar: what runs out, soonest first. */
  expiryIdx: index("person_certification_expiry_idx").on(t.organizationId, t.expiresOn),
  /**
   * A licence number is one licence. The same person holding the same type
   * under the same number twice is a duplicate, and two rows with different
   * expiry dates would make "is Dana current" depend on which was read first.
   * Partial, because a null reference is a real state for an authority that
   * issues no number, and nulls do not collide in a unique index anyway: the
   * predicate says so out loud rather than relying on that.
   */
  referenceIdx: uniqueIndex("person_certification_reference_idx")
    .on(t.technicianId, t.certificationTypeId, t.reference)
    .where(sql`${t.reference} is not null`),
}));
