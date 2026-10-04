import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ROLE_PRESETS, time, type RoleId } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as once from "./once";
import { held, type HeldCertification } from "./people";
import {
  ceWithin, contactsWithin, employmentWithin, onboardingWithin,
  type CeView, type EmergencyContactView, type EmploymentView, type OnboardingView,
} from "./people-records";
import { ownWithin, signWithin, signedPdfWithin, type OwnDocument, type SignInput } from "./staff-documents";
import type { PdfFile } from "./documents";

/**
 * M24. A PERSON'S OWN RECORD, SEEN AND KEPT BY THEM
 *
 * Everything the office keeps about somebody, shown to that somebody: the
 * facts of their employment, their certifications with when each runs out,
 * the continuing education behind a renewal, the onboarding they were given,
 * and the documents waiting for their signature. Three things they do
 * themselves: keep the people to ring if they are hurt, tick their own
 * onboarding lines, and sign what they were asked to sign.
 *
 * WHO "ME" IS COMES FROM THE SESSION AND NOTHING ELSE. No call here takes a
 * person's id. Each resolves the signed in user's own active membership in
 * this company, and every record it touches is checked to be that
 * membership's, so a line, a contact or a document of anybody else's reads
 * as not found. Reading anybody else's record is still `user:read`, on
 * `/v1/people/{membershipId}`, which no field preset holds.
 *
 * `profile:own`, which every preset holds. What somebody is paid is not
 * here: their own statements are payroll's, behind `payroll:own`
 * (`payroll.ownStatements`).
 */

export interface Self {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  branchName: string | null;
  locationName: string | null;
  technicianId: string | null;
}

/** The signed in person's own membership here, or a refusal: a connected app or the system is nobody's record. */
export async function selfWithin(tx: Database, ctx: ServiceContext): Promise<Self> {
  const [row] = await tx.select({
    membership: schema.membership,
    roleName: schema.role.name,
    branchName: schema.businessUnit.name,
    locationName: schema.location.name,
    technicianId: schema.technician.id,
  }).from(schema.membership)
    .leftJoin(schema.role, and(eq(schema.role.id, schema.membership.roleId), isNull(schema.role.deletedAt)))
    .leftJoin(schema.businessUnit, eq(schema.businessUnit.id, schema.membership.businessUnitId))
    .leftJoin(schema.location, eq(schema.location.id, schema.membership.locationId))
    .leftJoin(schema.technician, eq(schema.technician.membershipId, schema.membership.id))
    .where(and(
      eq(schema.membership.organizationId, ctx.actor.organizationId),
      eq(schema.membership.userId, ctx.actor.userId),
      eq(schema.membership.active, true),
    )).limit(1);
  if (!row) throw new NotFoundError("Your record");
  const [directory] = await tx.execute<{ name: string | null; email: string }>(
    sql`select name, email from app.organization_people() where membership_id = ${row.membership.id}`,
  );
  return {
    membershipId: row.membership.id,
    userId: row.membership.userId,
    name: directory?.name ?? directory?.email ?? "",
    email: directory?.email ?? "",
    role: row.membership.role,
    roleLabel: row.roleName ?? ROLE_PRESETS[row.membership.role as RoleId]?.label ?? row.membership.role,
    branchName: row.branchName,
    locationName: row.locationName,
    technicianId: row.technicianId,
  };
}

export interface MyRecord extends Self {
  employment: EmploymentView | null;
  emergencyContacts: EmergencyContactView[];
  onboarding: OnboardingView;
  documents: OwnDocument[];
  /** Theirs only, lapsed and revoked included: a renewal list that drops what has run out is empty when it matters. */
  certifications: HeldCertification[];
  continuingEducation: CeView | null;
}

export function record(ctx: ServiceContext): Promise<MyRecord> {
  return guardedRead(ctx, "profile:own", async (tx) => {
    const self = await selfWithin(tx, ctx);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    return {
      ...self,
      employment: await employmentWithin(tx, self.membershipId),
      emergencyContacts: await contactsWithin(tx, self.membershipId),
      onboarding: await onboardingWithin(tx, self.membershipId),
      documents: await ownWithin(tx, self.membershipId),
      certifications: self.technicianId
        ? await held(tx, ctx.actor.organizationId, { technicianIds: [self.technicianId], on: time.dateIn(new Date(), zone) })
        : [],
      continuingEducation: self.technicianId ? await ceWithin(tx, self.technicianId) : null,
    };
  });
}

/* ------------------------------------------------------ emergency contacts */

/**
 * Somebody to ring, added by the person themselves. The same rules as the
 * office's: a name and a number somebody can ring, in the order added.
 */
export function addContact(ctx: ServiceContext, input: {
  name: string; relationship?: string | null | undefined; phone: string;
  alternatePhone?: string | null | undefined; note?: string | null | undefined;
}): Promise<EmergencyContactView[]> {
  return guardedWrite(ctx, "profile:own", async (tx) => {
    const seen = await once.replayed<EmergencyContactView[]>(tx, ctx, "own_emergency_contact");
    if (seen) return seen;
    const self = await selfWithin(tx, ctx);
    const name = input.name.trim();
    const phone = input.phone.trim();
    if (name === "") throw new ConflictError("Say who to ring.");
    if (!/\d{3}/.test(phone)) throw new ConflictError("Give a phone number somebody can ring.");
    const existing = await contactsWithin(tx, self.membershipId);
    const [row] = await tx.insert(schema.emergencyContact).values({
      organizationId: ctx.actor.organizationId,
      membershipId: self.membershipId,
      name,
      relationship: input.relationship?.trim() || null,
      phone,
      alternatePhone: input.alternatePhone?.trim() || null,
      note: input.note?.trim() || null,
      priority: (existing.at(-1)?.priority ?? 0) + 1,
    }).returning({ id: schema.emergencyContact.id });
    await audit(tx, ctx, "emergency_contact.added", "membership", self.membershipId, null, {
      contactId: row!.id, name, by: "themselves",
    });
    const view = await contactsWithin(tx, self.membershipId);
    await once.remember(tx, ctx, "own_emergency_contact", row!.id, view);
    return view;
  });
}

/** Take one of their own contacts off. Somebody else's reads as not found. */
export function removeContact(ctx: ServiceContext, input: { id: string }): Promise<EmergencyContactView[]> {
  return guardedWrite(ctx, "profile:own", async (tx) => {
    const self = await selfWithin(tx, ctx);
    const [found] = await tx.select().from(schema.emergencyContact)
      .where(and(
        eq(schema.emergencyContact.id, input.id),
        eq(schema.emergencyContact.membershipId, self.membershipId),
      )).limit(1);
    if (!found) throw new NotFoundError("Emergency contact");
    /** Removed already, by this call's first attempt or by the office: the answer is the same list. */
    if (found.deletedAt) return contactsWithin(tx, self.membershipId);
    const [row] = await tx.update(schema.emergencyContact).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.emergencyContact.id, found.id)).returning();
    await audit(tx, ctx, "emergency_contact.removed", "membership", self.membershipId, row, { by: "themselves" });
    return contactsWithin(tx, self.membershipId);
  });
}

/* ------------------------------------------------------------ onboarding */

/**
 * Tick one of their own onboarding lines, or untick one they ticked.
 *
 * The line keeps who ticked it, so the office reads "done by Ray" beside a
 * line Ray ticked himself and can untick it if the gauges were not, in fact,
 * handed over. A person cannot untick a line somebody else ticked: that was
 * the office's record. A line that is a document is done by signing it, so
 * ticking it is refused with where to sign.
 */
export function setOnboardingLine(ctx: ServiceContext, input: {
  id: string; done: boolean; note?: string | null | undefined;
}): Promise<OnboardingView> {
  return guardedWrite(ctx, "profile:own", async (tx) => {
    const self = await selfWithin(tx, ctx);
    const [line] = await tx.select().from(schema.onboardingItem)
      .where(and(
        eq(schema.onboardingItem.id, input.id),
        eq(schema.onboardingItem.membershipId, self.membershipId),
      )).limit(1);
    if (!line) throw new NotFoundError("Onboarding line");

    if (input.done) {
      if (line.doneAt) return onboardingWithin(tx, self.membershipId);
      if (line.staffDocumentId) {
        throw new ConflictError("This one is done by signing the document. Sign it under Documents to sign.");
      }
    } else {
      if (!line.doneAt) return onboardingWithin(tx, self.membershipId);
      if (line.doneByUserId !== ctx.actor.userId) {
        throw new ConflictError("The office ticked this one. Ask them if it is not right.");
      }
    }

    await tx.update(schema.onboardingItem).set({
      doneAt: input.done ? new Date() : null,
      doneByUserId: input.done ? ctx.actor.userId : null,
      ...(input.done && input.note !== undefined ? { note: input.note?.trim() || null } : {}),
      ...(!input.done ? { note: null } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.onboardingItem.id, line.id));
    await audit(tx, ctx, input.done ? "onboarding.ticked" : "onboarding.unticked", "membership", self.membershipId,
      { doneAt: line.doneAt }, { label: line.label, by: "themselves" });
    return onboardingWithin(tx, self.membershipId);
  });
}

/* ---------------------------------------------------------- signing */

/**
 * One's own signed copy as a PDF. Somebody else's request, or one not signed
 * yet, is not something to print: the first is not found, as signing it would
 * not be, and the second is said in words.
 */
export function signedPdf(ctx: ServiceContext, input: { requestId: string }): Promise<PdfFile> {
  return guardedRead(ctx, "profile:own", async (tx) => {
    const self = await selfWithin(tx, ctx);
    return signedPdfWithin(tx, ctx, { requestId: input.requestId, membershipId: self.membershipId });
  });
}

/** Sign a document they were asked to sign, by typing their name or drawing it. */
export function sign(ctx: ServiceContext, input: SignInput): Promise<OwnDocument> {
  return guardedWrite(ctx, "profile:own", async (tx) => {
    const self = await selfWithin(tx, ctx);
    return signWithin(tx, ctx, { membershipId: self.membershipId, name: self.name, email: self.email }, input);
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  getMyRecord: (ctx: ServiceContext) => record(ctx),
  addMyEmergencyContact: async (ctx: ServiceContext, input: Parameters<typeof addContact>[1]) =>
    ({ contacts: await addContact(ctx, input) }),
  removeMyEmergencyContact: async (ctx: ServiceContext, input: { id: string }) =>
    ({ contacts: await removeContact(ctx, input) }),
  setMyOnboardingLine: (ctx: ServiceContext, input: { id: string; done: boolean; note?: string | null | undefined }) =>
    setOnboardingLine(ctx, input),
  signMyDocument: (ctx: ServiceContext, input: { requestId: string; typedName?: string | null | undefined; drawing?: string | null | undefined }) =>
    sign(ctx, input),
} as const;
