import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ROLE_PRESETS, assertCan, isSystem, people as peopleCore, qualification as q, time, type RoleId } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as once from "./once";
import { liveDrops, workSkills } from "./qualification";
import { bytesOf } from "./files";
import * as staffDocuments from "./staff-documents";

/**
 * M24. WHAT THE OFFICE KEEPS ABOUT A PERSON
 *
 * `people.ts` is the roster and the certification register. This is the rest:
 * onboarding against a checklist for the person's role, who to ring in an
 * emergency, the basic facts of their employment, continuing education hours
 * toward a renewal, the skills they have with when and how anybody knows,
 * and the skills one job asks for beyond its type.
 *
 * PERMISSIONS, and no new ones. Everything about a person as an employee is
 * the roster's: `user:read` to read it and `user:write` to change it, which
 * is who maintains the list of people already. Continuing education is a
 * record behind a certification and is `compliance:read` and
 * `compliance:write`, beside the register it belongs to. A job's extra
 * skills are `job:write`, like the rest of the job.
 *
 * NO PAY HERE. The employment record says how somebody is paid and the id
 * payroll knows them by, and nothing about how much: that is payroll's, behind
 * `payroll:read`, and copying a rate here would show a wage to everybody who
 * may read the staff list.
 */

/* ------------------------------------------------------------------ roles */

type Role = typeof schema.memberRole.enumValues[number];

const roleLabel = (role: string) => ROLE_PRESETS[role as RoleId]?.label ?? role;

async function membershipWithin(tx: Database, ctx: ServiceContext, membershipId: string) {
  const [row] = await tx.select().from(schema.membership)
    .where(and(eq(schema.membership.id, membershipId), eq(schema.membership.organizationId, ctx.actor.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Person");
  return row;
}

/* ------------------------------------------------------------- onboarding */

export interface TemplateItemView {
  id: string; role: string | null; roleId: string | null; roleLabel: string;
  kind: string; label: string; required: boolean; sortOrder: number;
  /** A document the person signs themselves to do this line, and its title. */
  staffDocumentId: string | null; documentTitle: string | null;
}

async function templateWithin(tx: Database): Promise<TemplateItemView[]> {
  const rows = await tx.select({
    item: schema.onboardingTemplateItem, roleName: schema.role.name, documentTitle: schema.staffDocument.title,
  })
    .from(schema.onboardingTemplateItem)
    .leftJoin(schema.role, eq(schema.role.id, schema.onboardingTemplateItem.roleId))
    .leftJoin(schema.staffDocument, eq(schema.staffDocument.id, schema.onboardingTemplateItem.staffDocumentId))
    .where(isNull(schema.onboardingTemplateItem.deletedAt))
    .orderBy(asc(schema.onboardingTemplateItem.sortOrder), asc(schema.onboardingTemplateItem.createdAt));
  return rows.map(({ item, roleName, documentTitle }) => ({
    id: item.id, role: item.role, roleId: item.roleId,
    roleLabel: item.role ? roleLabel(item.role) : roleName ?? "A role that was removed",
    kind: item.kind, label: item.label, required: item.required, sortOrder: item.sortOrder,
    staffDocumentId: item.staffDocumentId, documentTitle: documentTitle ?? null,
  }));
}

export function onboardingTemplate(ctx: ServiceContext) {
  return guardedRead(ctx, "user:read", (tx) => templateWithin(tx));
}

/**
 * A line on a role's checklist: a document to collect, training to give,
 * equipment to hand over. For a preset role or one of the company's own,
 * exactly one, because a custom role replaces the preset on a membership.
 */
export function addTemplateItem(ctx: ServiceContext, input: {
  role?: string | null | undefined; roleId?: string | null | undefined;
  kind: typeof schema.onboardingItemKind.enumValues[number]; label: string; required?: boolean | undefined;
  /** For a document line, the document the person signs themselves to do it. */
  staffDocumentId?: string | null | undefined;
}) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const seen = await once.replayed<TemplateItemView>(tx, ctx, "onboarding_template_item");
    if (seen) return seen;
    const label = input.label.trim();
    if (label === "") throw new ConflictError("Say what the line is: the document, the training, or the equipment.");
    const role = input.role ?? null;
    const roleId = input.roleId ?? null;
    if ((role === null) === (roleId === null)) throw new ConflictError("Name one role for the line: a preset, or one of the company's own roles.");
    if (role !== null && !(role in ROLE_PRESETS)) throw new ConflictError(`"${role}" is not a role.`);
    if (roleId !== null) {
      const [found] = await tx.select({ id: schema.role.id }).from(schema.role)
        .where(and(eq(schema.role.id, roleId), isNull(schema.role.deletedAt))).limit(1);
      if (!found) throw new NotFoundError("Role");
    }
    const staffDocumentId = input.staffDocumentId ?? null;
    if (staffDocumentId !== null) {
      if (input.kind !== "document") throw new ConflictError("Only a document line can be done by signing a document.");
      const [doc] = await tx.select({ retiredAt: schema.staffDocument.retiredAt, title: schema.staffDocument.title })
        .from(schema.staffDocument).where(eq(schema.staffDocument.id, staffDocumentId)).limit(1);
      if (!doc) throw new NotFoundError("Document");
      if (doc.retiredAt) throw new ConflictError(`${doc.title} has been retired. Choose its newer version.`);
    }
    const existing = (await templateWithin(tx)).filter((i) => i.role === role && i.roleId === roleId);
    const [row] = await tx.insert(schema.onboardingTemplateItem).values({
      organizationId: ctx.actor.organizationId,
      role: role as Role | null,
      roleId,
      kind: input.kind,
      label,
      required: input.required ?? true,
      sortOrder: (existing.at(-1)?.sortOrder ?? 0) + 1,
      staffDocumentId,
    }).returning();
    await audit(tx, ctx, "onboarding_template.added", "onboarding_template_item", row!.id, null, row!);
    const view = (await templateWithin(tx)).find((i) => i.id === row!.id)!;
    await once.remember(tx, ctx, "onboarding_template_item", row!.id, view);
    return view;
  });
}

/** Take a line off a role's checklist. People already started keep their copy of it. */
export function removeTemplateItem(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [row] = await tx.update(schema.onboardingTemplateItem).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.onboardingTemplateItem.id, input.id), isNull(schema.onboardingTemplateItem.deletedAt)))
      .returning();
    if (!row) throw new NotFoundError("Checklist line");
    await audit(tx, ctx, "onboarding_template.removed", "onboarding_template_item", row.id, row, null);
    return { id: row.id, removed: true as const };
  });
}

export interface OnboardingLineView {
  id: string; kind: string; label: string; required: boolean;
  doneAt: string | null; doneBy: string | null; note: string | null; companyAssetId: string | null;
  /** Who ticked it, so a person's own record can tell the lines they ticked from the office's. */
  doneByUserId: string | null;
  /** The document the person signs to do this line, when it is one. */
  staffDocumentId: string | null;
}

export interface OnboardingView {
  lines: OnboardingLineView[];
  progress: peopleCore.OnboardingProgress;
}

export async function onboardingWithin(tx: Database, membershipId: string): Promise<OnboardingView> {
  const rows = await tx.select().from(schema.onboardingItem)
    .where(eq(schema.onboardingItem.membershipId, membershipId))
    .orderBy(asc(schema.onboardingItem.sortOrder), asc(schema.onboardingItem.createdAt));
  const names = await peopleNames(tx);
  return {
    lines: rows.map((r) => ({
      id: r.id, kind: r.kind, label: r.label, required: r.required,
      doneAt: r.doneAt?.toISOString() ?? null,
      doneBy: r.doneByUserId ? names.get(r.doneByUserId) ?? null : null, doneByUserId: r.doneByUserId,
      note: r.note, companyAssetId: r.companyAssetId, staffDocumentId: r.staffDocumentId,
    })),
    progress: peopleCore.onboardingProgress(rows),
  };
}

/** Colleagues' names by user id, through the directory function: `user` itself shows only one's own row. */
async function peopleNames(tx: Database): Promise<Map<string, string>> {
  const rows = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  return new Map(rows.map((r) => [r.user_id, r.name ?? r.email]));
}

/**
 * Copy the checklist for this person's role onto them. Run again after the
 * checklist grows and only the new lines are added: each template line is
 * copied once per person, which the index holds.
 */
export function startOnboarding(ctx: ServiceContext, input: { membershipId: string }) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const member = await membershipWithin(tx, ctx, input.membershipId);
    const template = (await templateWithin(tx)).filter((i) =>
      member.roleId ? i.roleId === member.roleId : i.role === member.role && i.roleId === null);
    if (template.length === 0) {
      throw new ConflictError(
        `There is no onboarding checklist for ${member.roleId ? "their role" : roleLabel(member.role)} yet. Add its lines first.`,
      );
    }
    const added = await tx.insert(schema.onboardingItem).values(template.map((i) => ({
      organizationId: ctx.actor.organizationId,
      membershipId: member.id,
      templateItemId: i.id,
      kind: i.kind as typeof schema.onboardingItemKind.enumValues[number],
      label: i.label,
      required: i.required,
      sortOrder: i.sortOrder,
      staffDocumentId: i.staffDocumentId,
    }))).onConflictDoNothing().returning({ id: schema.onboardingItem.id });

    /**
     * THE DOCUMENTS ON THE CHECKLIST ARE HANDED TO THEM TO SIGN, and a
     * document they already signed (the handbook, asked for before their
     * onboarding was started) ticks its line straight away rather than
     * asking for a second signature. A document retired since the checklist
     * named it is not asked for; its line stays for the office to tick.
     */
    const documentIds = [...new Set(template.map((i) => i.staffDocumentId).filter((id): id is string => id !== null))];
    for (const documentId of documentIds) {
      const [doc] = await tx.select({ retiredAt: schema.staffDocument.retiredAt }).from(schema.staffDocument)
        .where(eq(schema.staffDocument.id, documentId)).limit(1);
      if (doc && !doc.retiredAt) await staffDocuments.askWithin(tx, ctx, documentId, [member.id]);
      const [signed] = await tx.select({ signedAt: schema.staffDocumentRequest.signedAt })
        .from(schema.staffDocumentRequest)
        .where(and(
          eq(schema.staffDocumentRequest.documentId, documentId),
          eq(schema.staffDocumentRequest.membershipId, member.id),
        )).limit(1);
      if (signed?.signedAt) {
        await tx.update(schema.onboardingItem).set({ doneAt: signed.signedAt, note: "Signed", updatedAt: new Date() })
          .where(and(
            eq(schema.onboardingItem.membershipId, member.id),
            eq(schema.onboardingItem.staffDocumentId, documentId),
            isNull(schema.onboardingItem.doneAt),
          ));
      }
    }
    await audit(tx, ctx, "onboarding.started", "membership", member.id, null, { added: added.length });
    return { added: added.length, onboarding: await onboardingWithin(tx, member.id) };
  });
}

/**
 * Tick a line, or untick one ticked by mistake. Who ticked it and when are
 * kept, and what was collected or handed over goes in the note: "I-9 seen",
 * "gauges, serial 2231". Equipment can name the asset on the fleet register.
 */
export function setOnboardingLine(ctx: ServiceContext, input: {
  id: string; done: boolean; note?: string | null | undefined; companyAssetId?: string | null | undefined;
}) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [line] = await tx.select().from(schema.onboardingItem)
      .where(eq(schema.onboardingItem.id, input.id)).limit(1);
    if (!line) throw new NotFoundError("Onboarding line");
    if (input.companyAssetId) {
      const [asset] = await tx.select({ id: schema.companyAsset.id }).from(schema.companyAsset)
        .where(eq(schema.companyAsset.id, input.companyAssetId)).limit(1);
      if (!asset) throw new NotFoundError("Asset");
    }
    await tx.update(schema.onboardingItem).set({
      doneAt: input.done ? line.doneAt ?? new Date() : null,
      doneByUserId: input.done ? line.doneByUserId ?? ctx.actor.userId : null,
      ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
      ...(input.companyAssetId !== undefined ? { companyAssetId: input.companyAssetId } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.onboardingItem.id, line.id));
    await audit(tx, ctx, input.done ? "onboarding.ticked" : "onboarding.unticked", "membership", line.membershipId,
      { doneAt: line.doneAt }, { label: line.label, note: input.note ?? line.note });
    return onboardingWithin(tx, line.membershipId);
  });
}

/* ------------------------------------------------------ emergency contacts */

export interface EmergencyContactView {
  id: string; name: string; relationship: string | null; phone: string; alternatePhone: string | null;
  note: string | null; priority: number;
}

export async function contactsWithin(tx: Database, membershipId: string): Promise<EmergencyContactView[]> {
  const rows = await tx.select().from(schema.emergencyContact)
    .where(and(eq(schema.emergencyContact.membershipId, membershipId), isNull(schema.emergencyContact.deletedAt)))
    .orderBy(asc(schema.emergencyContact.priority), asc(schema.emergencyContact.createdAt));
  return rows.map((r) => ({
    id: r.id, name: r.name, relationship: r.relationship, phone: r.phone,
    alternatePhone: r.alternatePhone, note: r.note, priority: r.priority,
  }));
}

/** Somebody to ring. A name and a number, both required: a contact with no number is a name nobody can reach. */
export function addEmergencyContact(ctx: ServiceContext, input: {
  membershipId: string; name: string; relationship?: string | null | undefined; phone: string;
  alternatePhone?: string | null | undefined; note?: string | null | undefined;
}) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const seen = await once.replayed<EmergencyContactView[]>(tx, ctx, "emergency_contact");
    if (seen) return seen;
    const member = await membershipWithin(tx, ctx, input.membershipId);
    const name = input.name.trim();
    const phone = input.phone.trim();
    if (name === "") throw new ConflictError("An emergency contact needs a name.");
    if (!/\d{3}/.test(phone)) throw new ConflictError("An emergency contact needs a phone number somebody can ring.");
    const existing = await contactsWithin(tx, member.id);
    const [row] = await tx.insert(schema.emergencyContact).values({
      organizationId: ctx.actor.organizationId,
      membershipId: member.id,
      name,
      relationship: input.relationship?.trim() || null,
      phone,
      alternatePhone: input.alternatePhone?.trim() || null,
      note: input.note?.trim() || null,
      priority: (existing.at(-1)?.priority ?? 0) + 1,
    }).returning({ id: schema.emergencyContact.id });
    await audit(tx, ctx, "emergency_contact.added", "membership", member.id, null, { contactId: row!.id, name });
    const view = await contactsWithin(tx, member.id);
    await once.remember(tx, ctx, "emergency_contact", row!.id, view);
    return view;
  });
}

export function removeEmergencyContact(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [row] = await tx.update(schema.emergencyContact).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.emergencyContact.id, input.id), isNull(schema.emergencyContact.deletedAt))).returning();
    if (!row) throw new NotFoundError("Emergency contact");
    await audit(tx, ctx, "emergency_contact.removed", "membership", row.membershipId, row, null);
    return contactsWithin(tx, row.membershipId);
  });
}

/* ------------------------------------------------------- employment record */

export interface EmploymentView {
  jobTitle: string | null; startedOn: string; endedOn: string | null;
  employmentType: string; payType: string; payrollReference: string | null;
}

export async function employmentWithin(tx: Database, membershipId: string): Promise<EmploymentView | null> {
  const [row] = await tx.select().from(schema.employmentRecord)
    .where(eq(schema.employmentRecord.membershipId, membershipId)).limit(1);
  return row ? {
    jobTitle: row.jobTitle, startedOn: row.startedOn, endedOn: row.endedOn,
    employmentType: row.employmentType, payType: row.payType, payrollReference: row.payrollReference,
  } : null;
}

/**
 * The basic facts of somebody's employment, set in place, with every change
 * in the audit log. An end before the start is refused: it is a typo, and a
 * person who left before they joined reads as never having worked here.
 */
export function setEmployment(ctx: ServiceContext, input: {
  membershipId: string; jobTitle?: string | null | undefined; startedOn: string; endedOn?: string | null | undefined;
  employmentType: typeof schema.employmentType.enumValues[number];
  payType: typeof schema.payType.enumValues[number];
  payrollReference?: string | null | undefined;
}) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const member = await membershipWithin(tx, ctx, input.membershipId);
    if (input.endedOn && input.endedOn < input.startedOn) {
      throw new ConflictError("That end date is before the start date.");
    }
    const before = await employmentWithin(tx, member.id);
    const values = {
      jobTitle: input.jobTitle?.trim() || null,
      startedOn: input.startedOn,
      endedOn: input.endedOn ?? null,
      employmentType: input.employmentType,
      payType: input.payType,
      payrollReference: input.payrollReference?.trim() || null,
    };
    await tx.insert(schema.employmentRecord).values({
      organizationId: ctx.actor.organizationId, membershipId: member.id, ...values,
    }).onConflictDoUpdate({
      target: [schema.employmentRecord.organizationId, schema.employmentRecord.membershipId],
      set: { ...values, updatedAt: new Date() },
    });
    await audit(tx, ctx, "employment_record.set", "membership", member.id, before, values);
    return (await employmentWithin(tx, member.id))!;
  });
}

/* ---------------------------------------------------------------- skills */

export interface SkillRecordView {
  id: string; skill: string; since: string; evidence: string; recordedBy: string | null;
  endedOn: string | null; endedReason: string | null;
  /** The last day the record stands, or null for one that does not expire. */
  expiresOn: string | null;
  /** Days ahead of the expiry it goes on the list to renew. */
  renewalLeadDays: number;
  /** Where it stands today against that expiry, in words. */
  expiry: peopleCore.SkillExpiryStanding;
}

export interface SkillsView {
  /** What the assignment check reads, each with its record when it has one. */
  current: { skill: string; record: SkillRecordView | null }[];
  /** Records still open for a skill taken off the list on the technicians screen without being ended here. */
  orphaned: SkillRecordView[];
  /** Ended records: the history. */
  ended: SkillRecordView[];
}

async function technicianWithin(tx: Database, ctx: ServiceContext, technicianId: string) {
  const [row] = await tx.select().from(schema.technician)
    .where(and(eq(schema.technician.id, technicianId), eq(schema.technician.organizationId, ctx.actor.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Technician");
  return row;
}

async function skillsWithin(tx: Database, technician: typeof schema.technician.$inferSelect): Promise<SkillsView> {
  const rows = await tx.select().from(schema.technicianSkill)
    .where(eq(schema.technicianSkill.technicianId, technician.id))
    .orderBy(desc(schema.technicianSkill.since));
  const names = await peopleNames(tx);
  const today = time.dateIn(new Date(), await timezoneOf(tx, technician.organizationId));
  const view = (r: typeof rows[number]): SkillRecordView => ({
    id: r.id, skill: r.skill, since: r.since, evidence: r.evidence,
    recordedBy: r.recordedByUserId ? names.get(r.recordedByUserId) ?? null : null,
    endedOn: r.endedOn, endedReason: r.endedReason,
    expiresOn: r.expiresOn, renewalLeadDays: r.renewalLeadDays,
    expiry: peopleCore.skillExpiryStanding({ skill: r.skill, expiresOn: r.expiresOn, today, leadDays: r.renewalLeadDays }),
  });
  const typed = q.normaliseSkills(technician.skills ?? []);
  const open = rows.filter((r) => r.endedOn === null);
  return {
    current: typed.map((skill) => {
      const record = open.find((r) => r.skill === skill);
      return { skill, record: record ? view(record) : null };
    }),
    orphaned: open.filter((r) => !typed.includes(r.skill)).map(view),
    ended: rows.filter((r) => r.endedOn !== null).map(view),
  };
}

/** One person's open skill records that have an expiry, soonest first, for their own record. */
export async function ownSkills(tx: Database, technicianId: string): Promise<SkillRecordView[]> {
  const technician = await tx.select().from(schema.technician).where(eq(schema.technician.id, technicianId)).limit(1);
  if (!technician[0]) return [];
  const view = await skillsWithin(tx, technician[0]);
  return view.current.flatMap((c) => (c.record && c.record.expiresOn ? [c.record] : []))
    .sort((a, b) => (a.expiresOn ?? "").localeCompare(b.expiresOn ?? ""));
}

export function skills(ctx: ServiceContext, input: { technicianId: string }) {
  return guardedRead(ctx, "user:read", async (tx) => skillsWithin(tx, await technicianWithin(tx, ctx, input.technicianId)));
}

/**
 * Record a skill with since when and what showed it, and put it on the list
 * the assignment check reads. Evidence is required: a skill with no evidence
 * is exactly the opaque string this record exists to replace.
 */
export function recordSkill(ctx: ServiceContext, input: {
  technicianId: string; skill: string; since: string; evidence: string;
  /** The last day it stands, for a skill that has to be shown again. Omitted does not expire. */
  expiresOn?: string | null | undefined;
  /** Days ahead to put it on the list to renew. 30 when omitted. */
  renewalLeadDays?: number | undefined;
}) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const seen = await once.replayed<SkillsView>(tx, ctx, "technician_skill");
    if (seen) return seen;
    const technician = await technicianWithin(tx, ctx, input.technicianId);
    const skill = input.skill.trim();
    const evidence = input.evidence.trim();
    if (skill === "") throw new ConflictError("Name the skill, as the job types spell it.");
    if (evidence === "") {
      throw new ConflictError("Say what showed it: who signed it off, the course, the test. A skill with no evidence is a string somebody typed.");
    }
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    if (input.since > time.dateIn(new Date(), zone)) {
      throw new ConflictError("That date is in the future. Record a skill on or after the day it was shown.");
    }
    const expiresOn = input.expiresOn ?? null;
    await assertExpiry(tx, ctx, { since: input.since, expiresOn });
    const [open] = await tx.select({ id: schema.technicianSkill.id }).from(schema.technicianSkill)
      .where(and(
        eq(schema.technicianSkill.technicianId, technician.id),
        eq(schema.technicianSkill.skill, skill),
        isNull(schema.technicianSkill.endedOn),
      )).limit(1);
    if (open) {
      throw new ConflictError(`${technician.displayName} already has ${skill} recorded. End that record first if the evidence has changed.`);
    }
    const [row] = await tx.insert(schema.technicianSkill).values({
      organizationId: ctx.actor.organizationId, technicianId: technician.id, skill, since: input.since, evidence,
      recordedByUserId: ctx.actor.userId,
      expiresOn,
      ...(input.renewalLeadDays !== undefined ? { renewalLeadDays: input.renewalLeadDays } : {}),
    }).returning({ id: schema.technicianSkill.id });
    const list = q.normaliseSkills([...(technician.skills ?? []), skill]);
    const [after] = await tx.update(schema.technician).set({ skills: list, updatedAt: new Date() })
      .where(eq(schema.technician.id, technician.id)).returning();
    await audit(tx, ctx, "technician.skill_recorded", "technician", technician.id,
      { skills: technician.skills }, { skills: list, skill, since: input.since, evidence, expiresOn });
    const view = await skillsWithin(tx, after!);
    await once.remember(tx, ctx, "technician_skill", row!.id, view);
    return view;
  });
}

/**
 * The last day a skill stands must come after the day it was shown, and not
 * already be over: a record that has run out the day it is written is a skill
 * somebody should not have recorded.
 */
async function assertExpiry(
  tx: Database, ctx: ServiceContext, input: { since: string; expiresOn: string | null },
): Promise<void> {
  if (input.expiresOn === null) return;
  if (input.expiresOn < input.since) throw new ConflictError("A skill cannot run out before the day it was shown.");
  const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
  if (input.expiresOn < today) {
    throw new ConflictError("That day has already passed. Give the last day the skill stands, from today on, or leave it blank if it does not run out.");
  }
}

/**
 * Give a skill record its own expiry, move it when the skill is shown again,
 * or take it off (null). The record stays: renewing is changing the day, with
 * the old one in the audit log, because a skill shown again has the same
 * evidence trail behind it.
 *
 * From the day after it, the skill stays on the person's list and no longer
 * clears the assignment check, the way a lapsed certification does not. It is
 * warned from `renewalLeadDays` before, on the list of what to renew.
 */
export function setSkillExpiry(ctx: ServiceContext, input: {
  id: string; expiresOn: string | null; renewalLeadDays?: number | undefined;
}) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [row] = await tx.select().from(schema.technicianSkill)
      .where(and(
        eq(schema.technicianSkill.id, input.id),
        eq(schema.technicianSkill.organizationId, ctx.actor.organizationId),
        isNull(schema.technicianSkill.endedOn),
      )).limit(1);
    if (!row) throw new NotFoundError("Open skill record");
    await assertExpiry(tx, ctx, { since: row.since, expiresOn: input.expiresOn });
    await tx.update(schema.technicianSkill).set({
      expiresOn: input.expiresOn,
      ...(input.renewalLeadDays !== undefined ? { renewalLeadDays: input.renewalLeadDays } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.technicianSkill.id, row.id));
    await audit(tx, ctx, "technician.skill_expiry_set", "technician", row.technicianId,
      { skill: row.skill, expiresOn: row.expiresOn, renewalLeadDays: row.renewalLeadDays },
      { skill: row.skill, expiresOn: input.expiresOn, renewalLeadDays: input.renewalLeadDays ?? row.renewalLeadDays });
    return skillsWithin(tx, await technicianWithin(tx, ctx, row.technicianId));
  });
}

export interface ExpiringSkill {
  id: string; technicianId: string; technicianName: string; skill: string;
  expiresOn: string; daysRemaining: number; renewalLeadDays: number;
  /** False once the day after it has come: the skill no longer clears the check. */
  current: boolean;
  sentence: string;
}

/**
 * SKILLS ABOUT TO RUN OUT, AND THE ONES THAT HAVE, listed the way the
 * certification renewal list is: each record's own notice period puts it on,
 * `within` asks "the next so many days" instead, and an expired one stays on
 * (still open, still on the person's list) because a list that drops a skill
 * the day it lapses is empty exactly when somebody needed it.
 */
export function expiringSkills(ctx: ServiceContext, input: { within?: number | undefined } = {}) {
  return guardedRead(ctx, "user:read", async (tx): Promise<ExpiringSkill[]> => {
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const rows = await tx.select({
      record: schema.technicianSkill, name: schema.technician.displayName,
    }).from(schema.technicianSkill)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.technicianSkill.technicianId))
      .where(and(
        eq(schema.technicianSkill.organizationId, ctx.actor.organizationId),
        isNull(schema.technicianSkill.endedOn),
        sql`${schema.technicianSkill.expiresOn} is not null`,
        eq(schema.technician.active, true),
      ))
      .orderBy(asc(schema.technicianSkill.expiresOn), asc(schema.technician.displayName));
    const out: ExpiringSkill[] = [];
    for (const { record, name } of rows) {
      const standing = peopleCore.skillExpiryStanding({
        skill: record.skill, expiresOn: record.expiresOn, today, leadDays: input.within ?? record.renewalLeadDays,
      });
      if (standing.state !== "expiring" && standing.state !== "expired") continue;
      out.push({
        id: record.id, technicianId: record.technicianId, technicianName: name, skill: record.skill,
        expiresOn: record.expiresOn!, daysRemaining: standing.daysRemaining!,
        renewalLeadDays: record.renewalLeadDays, current: standing.state !== "expired",
        sentence: `${name}: ${standing.sentence}`,
      });
    }
    return out;
  });
}

/**
 * End a skill: take it off the list the check reads, and keep the record with
 * the day and the reason, so "could Sam braze in March" still has an answer.
 */
export function endSkill(ctx: ServiceContext, input: { id: string; reason: string; endedOn?: string | undefined }) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [row] = await tx.select().from(schema.technicianSkill)
      .where(and(eq(schema.technicianSkill.id, input.id), isNull(schema.technicianSkill.endedOn))).limit(1);
    if (!row) throw new NotFoundError("Open skill record");
    const reason = input.reason.trim();
    if (reason === "") throw new ConflictError("Say why the skill no longer stands.");
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const endedOn = input.endedOn ?? time.dateIn(new Date(), zone);
    if (endedOn < row.since) throw new ConflictError("A skill cannot end before it was recorded.");
    await tx.update(schema.technicianSkill).set({ endedOn, endedReason: reason, updatedAt: new Date() })
      .where(eq(schema.technicianSkill.id, row.id));
    const technician = await technicianWithin(tx, ctx, row.technicianId);
    const list = (technician.skills ?? []).filter((s) => s.trim() !== row.skill);
    const [after] = await tx.update(schema.technician).set({ skills: list, updatedAt: new Date() })
      .where(eq(schema.technician.id, technician.id)).returning();
    await audit(tx, ctx, "technician.skill_ended", "technician", technician.id,
      { skills: technician.skills }, { skills: list, skill: row.skill, reason });
    return skillsWithin(tx, after!);
  });
}

/* --------------------------------------------------- continuing education */

export interface CeEntryView {
  id: string; certificationTypeId: string; completedOn: string; hours: string;
  course: string; provider: string | null; evidence: string | null;
  /** Only approved hours count toward a renewal. */
  status: "pending" | "approved" | "declined";
  /** The person logged it themselves, from their own record. */
  selfLogged: boolean;
  declineReason: string | null;
  /** Photographs of the certificate kept with it. */
  certificates: number;
}

export interface CeView {
  entries: CeEntryView[];
  /** Per certification type the person holds or has hours toward. Counts approved hours only. */
  progress: {
    certificationTypeId: string; name: string; holding: { issuedOn: string | null; expiresOn: string | null } | null;
    progress: peopleCore.CeProgress;
    /** Hours the person logged that wait for the office, not counted yet. */
    pendingHours: string;
  }[];
}

export async function ceWithin(tx: Database, technicianId: string): Promise<CeView> {
  const all = await tx.select().from(schema.continuingEducation)
    .where(and(eq(schema.continuingEducation.technicianId, technicianId), isNull(schema.continuingEducation.deletedAt)))
    .orderBy(desc(schema.continuingEducation.completedOn));
  /**
   * ONLY APPROVED HOURS COUNT. A person's own entry waits for the office to
   * look at the certificate, and a declined one never counts; both are listed
   * so the person can see where each stands.
   */
  const rows = all.filter((r) => r.status === "approved");
  const waiting = all.filter((r) => r.status === "pending");
  const certificates = all.length === 0 ? [] : await tx.select({ entityId: schema.attachment.entityId })
    .from(schema.attachment)
    .where(and(
      eq(schema.attachment.entityType, "continuing_education"),
      inArray(schema.attachment.entityId, all.map((r) => r.id)),
      isNull(schema.attachment.deletedAt),
    ));
  const holdings = await tx.select().from(schema.personCertification)
    .where(eq(schema.personCertification.technicianId, technicianId));
  const typeIds = [...new Set([...all.map((r) => r.certificationTypeId), ...holdings.map((h) => h.certificationTypeId)])];
  const types = typeIds.length === 0 ? [] : await tx.select().from(schema.certificationType)
    .where(inArray(schema.certificationType.id, typeIds));

  const progress = types
    .filter((t) => t.ceHoursRequired !== null || all.some((r) => r.certificationTypeId === t.id))
    .map((t) => {
      /** The current holding is the one with the furthest expiry, as the register reads it. */
      const current = holdings.filter((h) => h.certificationTypeId === t.id && h.status === "active")
        .sort((a, b) => (b.expiresOn ?? "9999-12-31").localeCompare(a.expiresOn ?? "9999-12-31"))[0];
      return {
        certificationTypeId: t.id,
        name: t.name,
        holding: current ? { issuedOn: current.issuedOn, expiresOn: current.expiresOn } : null,
        progress: peopleCore.ceProgress({
          required: t.ceHoursRequired,
          entries: rows.filter((r) => r.certificationTypeId === t.id),
          since: current?.issuedOn ?? null,
          by: current?.expiresOn ?? null,
        }),
        pendingHours: peopleCore.hoursLabel(
          waiting.filter((r) => r.certificationTypeId === t.id && (current?.issuedOn == null || r.completedOn >= current.issuedOn))
            .reduce((sum, r) => sum + peopleCore.hundredths(r.hours), 0n),
        ),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    entries: all.map((r) => ({
      id: r.id, certificationTypeId: r.certificationTypeId, completedOn: r.completedOn,
      hours: peopleCore.hoursLabel(peopleCore.hundredths(r.hours)), course: r.course, provider: r.provider, evidence: r.evidence,
      status: r.status, selfLogged: r.selfLogged, declineReason: r.declineReason,
      certificates: certificates.filter((c) => c.entityId === r.id).length,
    })),
    progress,
  };
}

export function continuingEducation(ctx: ServiceContext, input: { technicianId: string }) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    await technicianWithin(tx, ctx, input.technicianId);
    return ceWithin(tx, input.technicianId);
  });
}

/** Hours of a course, toward a certification's renewal. */
export function logContinuingEducation(ctx: ServiceContext, input: {
  technicianId: string; certificationTypeId: string; completedOn: string; hours: string;
  course: string; provider?: string | null | undefined; evidence?: string | null | undefined;
}) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const seen = await once.replayed<CeView>(tx, ctx, "continuing_education");
    if (seen) return seen;
    await technicianWithin(tx, ctx, input.technicianId);
    const [type] = await tx.select({ id: schema.certificationType.id }).from(schema.certificationType)
      .where(eq(schema.certificationType.id, input.certificationTypeId)).limit(1);
    if (!type) throw new NotFoundError("Certification type");
    const course = input.course.trim();
    if (course === "") throw new ConflictError("Name the course, as the certificate does.");
    let hundredths: bigint;
    try { hundredths = peopleCore.hundredths(input.hours); } catch {
      throw new ConflictError(`"${input.hours}" is not a number of hours.`);
    }
    if (hundredths <= 0n) throw new ConflictError("A course is more than no hours.");
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    if (input.completedOn > time.dateIn(new Date(), zone)) {
      throw new ConflictError("That course finishes in the future. Log the hours once they are done.");
    }
    const [row] = await tx.insert(schema.continuingEducation).values({
      organizationId: ctx.actor.organizationId,
      technicianId: input.technicianId,
      certificationTypeId: input.certificationTypeId,
      completedOn: input.completedOn,
      hours: peopleCore.hoursLabel(hundredths),
      course,
      provider: input.provider?.trim() || null,
      evidence: input.evidence?.trim() || null,
      recordedByUserId: ctx.actor.userId,
    }).returning({ id: schema.continuingEducation.id });
    await audit(tx, ctx, "continuing_education.logged", "technician", input.technicianId, null, {
      entryId: row!.id, course, hours: input.hours,
    });
    const view = await ceWithin(tx, input.technicianId);
    await once.remember(tx, ctx, "continuing_education", row!.id, view);
    return view;
  });
}

/* ------------------- hours a person logged themselves, waiting for the office */

export interface PendingCeView {
  id: string; technicianId: string; technicianName: string;
  certificationTypeId: string; certificationName: string;
  completedOn: string; hours: string; course: string; provider: string | null; evidence: string | null;
  certificates: number; loggedAt: string;
}

/**
 * HOURS WAITING FOR THE OFFICE. Every self-logged entry nobody has answered, oldest first,
 * with how many photographs of the certificate came with it.
 */
export function pendingContinuingEducation(ctx: ServiceContext) {
  return guardedRead(ctx, "compliance:read", async (tx): Promise<PendingCeView[]> => {
    const rows = await tx.select({
      entry: schema.continuingEducation, technicianName: schema.technician.displayName,
      certificationName: schema.certificationType.name,
    }).from(schema.continuingEducation)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.continuingEducation.technicianId))
      .innerJoin(schema.certificationType, eq(schema.certificationType.id, schema.continuingEducation.certificationTypeId))
      .where(and(
        eq(schema.continuingEducation.organizationId, ctx.actor.organizationId),
        eq(schema.continuingEducation.status, "pending"),
        isNull(schema.continuingEducation.deletedAt),
      ))
      .orderBy(asc(schema.continuingEducation.createdAt));
    const photos = rows.length === 0 ? [] : await tx.select({ entityId: schema.attachment.entityId }).from(schema.attachment)
      .where(and(
        eq(schema.attachment.entityType, "continuing_education"),
        inArray(schema.attachment.entityId, rows.map((r) => r.entry.id)),
        isNull(schema.attachment.deletedAt),
      ));
    return rows.map(({ entry, technicianName, certificationName }) => ({
      id: entry.id, technicianId: entry.technicianId, technicianName,
      certificationTypeId: entry.certificationTypeId, certificationName,
      completedOn: entry.completedOn, hours: peopleCore.hoursLabel(peopleCore.hundredths(entry.hours)),
      course: entry.course, provider: entry.provider, evidence: entry.evidence,
      certificates: photos.filter((p) => p.entityId === entry.id).length,
      loggedAt: entry.createdAt.toISOString(),
    }));
  });
}

async function pendingEntry(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.continuingEducation)
    .where(and(
      eq(schema.continuingEducation.id, id),
      eq(schema.continuingEducation.organizationId, ctx.actor.organizationId),
      isNull(schema.continuingEducation.deletedAt),
    )).for("update").limit(1);
  if (!row) throw new NotFoundError("Course");
  return row;
}

/**
 * Count a person's own hours toward the renewal. The office has looked at the certificate.
 * Approving what is already approved answers with the same list, so a second
 * person pressing the same button changes nothing. A declined entry is not
 * approved afterwards: the person logs it again, so the record of the refusal
 * stays what it was.
 */
export function approveContinuingEducation(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const row = await pendingEntry(tx, ctx, input.id);
    if (row.status === "declined") {
      throw new ConflictError("That entry was declined. Ask the person to log the hours again with the right certificate.");
    }
    if (row.status === "pending") {
      await tx.update(schema.continuingEducation).set({
        status: "approved", decidedAt: new Date(), decidedByUserId: ctx.actor.userId, updatedAt: new Date(),
      }).where(eq(schema.continuingEducation.id, row.id));
      await audit(tx, ctx, "continuing_education.approved", "technician", row.technicianId,
        { status: "pending" }, { entryId: row.id, course: row.course, hours: row.hours });
    }
    return ceWithin(tx, row.technicianId);
  });
}

/** Turn a person's own hours down, with a reason they read on their record. Never counted. */
export function declineContinuingEducation(ctx: ServiceContext, input: { id: string; reason: string }) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const row = await pendingEntry(tx, ctx, input.id);
    const reason = input.reason.trim();
    if (reason === "") throw new ConflictError("Say why, so the person knows what to fix.");
    if (row.status === "approved") {
      throw new ConflictError("Those hours are already counted. Remove them from the list if they were counted by mistake.");
    }
    if (row.status === "pending") {
      await tx.update(schema.continuingEducation).set({
        status: "declined", decidedAt: new Date(), decidedByUserId: ctx.actor.userId, declineReason: reason, updatedAt: new Date(),
      }).where(eq(schema.continuingEducation.id, row.id));
      await audit(tx, ctx, "continuing_education.declined", "technician", row.technicianId,
        { status: "pending" }, { entryId: row.id, course: row.course, hours: row.hours, reason });
    }
    return ceWithin(tx, row.technicianId);
  });
}

/**
 * The bytes of one certificate photograph, `index` oldest first. For whoever reads
 * the register (`compliance:read`) and for the person whose hours they are; nobody
 * else's certificate is served to anybody else.
 */
export function ceCertificate(ctx: ServiceContext, input: { id: string; index?: number | undefined }) {
  return guardedRead(ctx, "profile:own", async (tx): Promise<{ bytes: Buffer; contentType: string }> => {
    const [row] = await tx.select().from(schema.continuingEducation)
      .where(and(
        eq(schema.continuingEducation.id, input.id),
        eq(schema.continuingEducation.organizationId, ctx.actor.organizationId),
        isNull(schema.continuingEducation.deletedAt),
      )).limit(1);
    if (!row) throw new NotFoundError("Certificate");
    const [own] = await tx.select({ id: schema.technician.id }).from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(and(eq(schema.membership.userId, ctx.actor.userId), eq(schema.technician.id, row.technicianId))).limit(1);
    if (!own) assertCan(ctx.actor, "compliance:read");
    const [file] = await tx.select({ storage: schema.storedFile }).from(schema.attachment)
      .innerJoin(schema.storedFile, and(
        eq(schema.storedFile.organizationId, schema.attachment.organizationId),
        eq(schema.storedFile.storageKey, schema.attachment.storageKey),
      ))
      .where(and(
        eq(schema.attachment.entityType, "continuing_education"),
        eq(schema.attachment.entityId, row.id),
        isNull(schema.attachment.deletedAt),
        isNull(schema.storedFile.deletedAt),
      ))
      .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id))
      .offset(Math.max(0, input.index ?? 0)).limit(1);
    if (!file) throw new NotFoundError("Certificate");
    return { bytes: await bytesOf(file.storage), contentType: file.storage.contentType };
  });
}

export function removeContinuingEducation(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const [row] = await tx.update(schema.continuingEducation).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.continuingEducation.id, input.id), isNull(schema.continuingEducation.deletedAt))).returning();
    if (!row) throw new NotFoundError("Course");
    await audit(tx, ctx, "continuing_education.removed", "technician", row.technicianId, row, null);
    return ceWithin(tx, row.technicianId);
  });
}

/* ------------------------------------------------------------ one person */

export interface PersonView {
  membershipId: string;
  name: string | null;
  email: string;
  role: string;
  roleLabel: string;
  active: boolean;
  technicianId: string | null;
  onboarding: OnboardingView;
  emergencyContacts: EmergencyContactView[];
  employment: EmploymentView | null;
  skills: SkillsView | null;
  /**
   * Who they report to, from the same line the escalation screen sets (M34), so the
   * two cannot disagree. Null when nobody is recorded. `active` is false for a manager
   * who has left, whose line is still there until somebody changes it.
   */
  reportsTo: { membershipId: string; name: string | null; email: string; active: boolean } | null;
  /** What they were asked to sign, and whether they have. */
  documents: { requestId: string; documentId: string; title: string; askedAt: string; signedAt: string | null; signedVia: string | null }[];
}

export function person(ctx: ServiceContext, input: { membershipId: string }) {
  return guardedRead(ctx, "user:read", async (tx): Promise<PersonView> => {
    const member = await membershipWithin(tx, ctx, input.membershipId);
    const [directory] = await tx.execute<{ name: string | null; email: string }>(
      sql`select name, email from app.organization_people() where membership_id = ${member.id}`,
    );
    const [custom] = member.roleId ? await tx.select({ name: schema.role.name }).from(schema.role)
      .where(eq(schema.role.id, member.roleId)).limit(1) : [];
    const [technician] = await tx.select().from(schema.technician)
      .where(eq(schema.technician.membershipId, member.id)).limit(1);
    const [manager] = member.reportsToUserId
      ? await tx.select({ id: schema.membership.id, active: schema.membership.active }).from(schema.membership)
        .where(and(
          eq(schema.membership.organizationId, ctx.actor.organizationId),
          eq(schema.membership.userId, member.reportsToUserId),
        )).limit(1)
      : [];
    const [managerName] = manager
      ? await tx.execute<{ name: string | null; email: string }>(
        sql`select name, email from app.organization_people() where membership_id = ${manager.id}`)
      : [];
    return {
      membershipId: member.id,
      name: directory?.name ?? null,
      email: directory?.email ?? "",
      role: member.role,
      roleLabel: custom?.name ?? roleLabel(member.role),
      active: member.active,
      technicianId: technician?.id ?? null,
      onboarding: await onboardingWithin(tx, member.id),
      emergencyContacts: await contactsWithin(tx, member.id),
      employment: await employmentWithin(tx, member.id),
      skills: technician ? await skillsWithin(tx, technician) : null,
      reportsTo: manager
        ? { membershipId: manager.id, name: managerName?.name ?? null, email: managerName?.email ?? "", active: manager.active }
        : null,
      documents: (await staffDocuments.ownWithin(tx, member.id)).map(({ body: _body, signerName: _signer, ...rest }) => rest),
    };
  });
}

export interface RosterRow {
  membershipId: string; name: string | null; email: string; roleLabel: string; active: boolean;
  technicianId: string | null; startedOn: string | null; onboarding: peopleCore.OnboardingProgress;
  emergencyContacts: number;
}

/** Everybody, with how far through onboarding they are and whether anybody is on file to ring. */
export function roster(ctx: ServiceContext) {
  return guardedRead(ctx, "user:read", async (tx): Promise<RosterRow[]> => {
    const directory = await tx.execute<{ membership_id: string; name: string | null; email: string }>(
      sql`select membership_id, name, email from app.organization_people()`,
    );
    const members = await tx.select({
      membership: schema.membership, roleName: schema.role.name, technicianId: schema.technician.id,
    }).from(schema.membership)
      .leftJoin(schema.role, eq(schema.role.id, schema.membership.roleId))
      .leftJoin(schema.technician, eq(schema.technician.membershipId, schema.membership.id))
      .where(eq(schema.membership.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.membership.createdAt));
    const lines = await tx.select({ membershipId: schema.onboardingItem.membershipId, required: schema.onboardingItem.required, doneAt: schema.onboardingItem.doneAt })
      .from(schema.onboardingItem);
    const contacts = await tx.select({ membershipId: schema.emergencyContact.membershipId })
      .from(schema.emergencyContact).where(isNull(schema.emergencyContact.deletedAt));
    const employment = await tx.select({ membershipId: schema.employmentRecord.membershipId, startedOn: schema.employmentRecord.startedOn })
      .from(schema.employmentRecord);
    const nameOf = new Map(directory.map((d) => [d.membership_id, d]));
    return members.map(({ membership, roleName, technicianId }) => ({
      membershipId: membership.id,
      name: nameOf.get(membership.id)?.name ?? null,
      email: nameOf.get(membership.id)?.email ?? "",
      roleLabel: roleName ?? roleLabel(membership.role),
      active: membership.active,
      technicianId,
      startedOn: employment.find((e) => e.membershipId === membership.id)?.startedOn ?? null,
      onboarding: peopleCore.onboardingProgress(lines.filter((l) => l.membershipId === membership.id)),
      emergencyContacts: contacts.filter((c) => c.membershipId === membership.id).length,
    }));
  });
}

/* --------------------------------------------------------- a job's skills */

export interface JobSkillsView {
  id: string;
  /** What this job asks for beyond its type. */
  skills: string[];
  /** Everything its type asks for, dropped or not. */
  typeSkills: string[];
  /** The type's skills this job dropped, each with why, who and when. Only ones its type still asks for. */
  dropped: { skill: string; reason: string; droppedAt: string; droppedBy: string | null }[];
  /** What is actually checked for whoever is sent: the type's less the dropped, and the job's own. */
  checked: string[];
}

type JobSkillRow = {
  id: string; requiredSkills: string[]; droppedSkills: typeof schema.job.$inferSelect["droppedSkills"]; jobTypeId: string | null;
};

async function loadJobSkillRow(tx: Database, ctx: ServiceContext, id: string): Promise<JobSkillRow & { typeSkills: string[] }> {
  const [job] = await tx.select({
    id: schema.job.id, requiredSkills: schema.job.requiredSkills,
    droppedSkills: schema.job.droppedSkills, jobTypeId: schema.job.jobTypeId,
  }).from(schema.job)
    .where(and(eq(schema.job.id, id), eq(schema.job.organizationId, ctx.actor.organizationId), isNull(schema.job.deletedAt)))
    .limit(1);
  if (!job) throw new NotFoundError("Job");
  const [type] = job.jobTypeId ? await tx.select({ skills: schema.jobType.requiredSkills }).from(schema.jobType)
    .where(eq(schema.jobType.id, job.jobTypeId)).limit(1) : [];
  return { ...job, typeSkills: q.normaliseSkills(type?.skills ?? []) };
}

async function jobSkillsView(tx: Database, row: JobSkillRow & { typeSkills: string[] }): Promise<JobSkillsView> {
  const names = await peopleNames(tx);
  const live = liveDrops(row.typeSkills, row.droppedSkills);
  return {
    id: row.id,
    skills: q.normaliseSkills(row.requiredSkills ?? []),
    typeSkills: row.typeSkills,
    dropped: live.map((d) => ({
      skill: d.skill, reason: d.reason, droppedAt: d.droppedAt,
      droppedBy: d.droppedByUserId ? names.get(d.droppedByUserId) ?? null : null,
    })),
    checked: workSkills(row.typeSkills, row.requiredSkills, row.droppedSkills),
  };
}

/**
 * The skills this one job needs beyond its type. Replaces the job's own list;
 * the type's are untouched and still apply. Checked from then on wherever
 * the type's are: the board, assignment, booking a visit, crews and the
 * suggestions.
 */
export function setJobSkills(ctx: ServiceContext, input: { id: string; skills: string[] }) {
  return guardedWrite(ctx, "job:write", async (tx): Promise<JobSkillsView> => {
    const job = await loadJobSkillRow(tx, ctx, input.id);
    /** Only what the type does not already ask: the rest is said once, on the type. */
    const extra = q.normaliseSkills(input.skills).filter((s) => !job.typeSkills.includes(s));
    await tx.update(schema.job).set({ requiredSkills: extra, updatedAt: new Date() }).where(eq(schema.job.id, job.id));
    await audit(tx, ctx, "job.skills_set", "job", job.id, { requiredSkills: job.requiredSkills }, { requiredSkills: extra });
    return jobSkillsView(tx, { ...job, requiredSkills: extra });
  });
}

export function jobSkills(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "job:read", async (tx): Promise<JobSkillsView> =>
    jobSkillsView(tx, await loadJobSkillRow(tx, ctx, input.id)));
}

/**
 * DROP ONE OF THE JOB TYPE'S SKILLS FOR THIS ONE JOB, with the reason.
 *
 * From then on it is not asked of whoever is sent on this job, on the board, at
 * booking, for a crew and in the suggestions: every path reads the job's skills
 * through `workSkills`. The reason is kept and shown on the job, beside the
 * skills, and in the audit entry of every assignment made while it stands.
 *
 * `visit:assign_unqualified`, not `job:write`. Dropping a skill lets people be
 * sent without it and nothing is overridden at the moment they are sent, so it
 * is the same power as the override and sits with the same people. Putting it
 * back (`restoreSkill`) only tightens, so `job:write` is enough.
 *
 * Only a skill the job's type asks for can be dropped: the job's own extra
 * skills are removed from the list they were added to, not "dropped".
 */
export function dropSkill(ctx: ServiceContext, input: { id: string; skill: string; reason: string }) {
  return guardedWrite(ctx, "job:write", async (tx): Promise<JobSkillsView> => {
    assertCan(ctx.actor, "visit:assign_unqualified");
    const job = await loadJobSkillRow(tx, ctx, input.id);
    const skill = input.skill.trim();
    const reason = input.reason.trim();
    if (!job.typeSkills.includes(skill)) {
      throw new ConflictError(
        `${skill === "" ? "That" : skill} is not one of this job type's skills, so there is nothing to drop. `
        + "Skills this job added for itself are taken off the list of what it also needs.",
      );
    }
    if (reason.length < 5) throw new ConflictError("Say why this job does not need it, in a sentence somebody reading the job later would accept.");
    /** Dropping it twice is the first drop: the reason on the job stays the one first given. */
    if (job.droppedSkills.some((d) => d.skill === skill)) return jobSkillsView(tx, job);
    const dropped = [
      ...job.droppedSkills,
      { skill, reason, droppedAt: new Date().toISOString(), droppedByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId },
    ];
    await tx.update(schema.job).set({ droppedSkills: dropped, updatedAt: new Date() }).where(eq(schema.job.id, job.id));
    await audit(tx, ctx, "job.skill_dropped", "job", job.id,
      { droppedSkills: job.droppedSkills }, { droppedSkills: dropped, skill, reason });
    return jobSkillsView(tx, { ...job, droppedSkills: dropped });
  });
}

/** Ask for the skill again on this job. Tightens the check, so it needs only `job:write`. */
export function restoreSkill(ctx: ServiceContext, input: { id: string; skill: string }) {
  return guardedWrite(ctx, "job:write", async (tx): Promise<JobSkillsView> => {
    const job = await loadJobSkillRow(tx, ctx, input.id);
    const skill = input.skill.trim();
    const kept = job.droppedSkills.filter((d) => d.skill !== skill);
    if (kept.length === job.droppedSkills.length) return jobSkillsView(tx, job);
    await tx.update(schema.job).set({ droppedSkills: kept, updatedAt: new Date() }).where(eq(schema.job.id, job.id));
    await audit(tx, ctx, "job.skill_restored", "job", job.id,
      { droppedSkills: job.droppedSkills }, { droppedSkills: kept, skill });
    return jobSkillsView(tx, { ...job, droppedSkills: kept });
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listPeopleRoster: async (ctx: ServiceContext): Promise<{ people: RosterRow[] }> => ({ people: await roster(ctx) }),
  getPersonRecord: (ctx: ServiceContext, input: { membershipId: string }): Promise<PersonView> => person(ctx, input),
  listOnboardingTemplate: async (ctx: ServiceContext): Promise<{ items: TemplateItemView[] }> => ({ items: await onboardingTemplate(ctx) }),
  addOnboardingTemplateItem: (ctx: ServiceContext, input: {
    role?: string | null | undefined; roleId?: string | null | undefined;
    kind: "document" | "training" | "equipment" | "other"; label: string; required?: boolean | undefined;
    staffDocumentId?: string | null | undefined;
  }): Promise<TemplateItemView> => addTemplateItem(ctx, input),
  removeOnboardingTemplateItem: (ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> =>
    removeTemplateItem(ctx, input),
  startOnboarding: (ctx: ServiceContext, input: { membershipId: string }): Promise<{ added: number; onboarding: OnboardingView }> =>
    startOnboarding(ctx, input),
  setOnboardingLine: (ctx: ServiceContext, input: {
    id: string; done: boolean; note?: string | null | undefined; companyAssetId?: string | null | undefined;
  }): Promise<OnboardingView> => setOnboardingLine(ctx, input),
  addEmergencyContact: async (ctx: ServiceContext, input: {
    membershipId: string; name: string; relationship?: string | null | undefined; phone: string;
    alternatePhone?: string | null | undefined; note?: string | null | undefined;
  }): Promise<{ contacts: EmergencyContactView[] }> => ({ contacts: await addEmergencyContact(ctx, input) }),
  removeEmergencyContact: async (ctx: ServiceContext, input: { id: string }): Promise<{ contacts: EmergencyContactView[] }> =>
    ({ contacts: await removeEmergencyContact(ctx, input) }),
  setEmploymentRecord: (ctx: ServiceContext, input: {
    membershipId: string; jobTitle?: string | null | undefined; startedOn: string; endedOn?: string | null | undefined;
    employmentType: "full_time" | "part_time" | "seasonal" | "temporary" | "contractor";
    payType: "hourly" | "salary" | "piece_rate" | "commission_only";
    payrollReference?: string | null | undefined;
  }): Promise<EmploymentView> => setEmployment(ctx, input),
  listTechnicianSkills: (ctx: ServiceContext, input: { technicianId: string }): Promise<SkillsView> => skills(ctx, input),
  recordTechnicianSkill: (ctx: ServiceContext, input: {
    technicianId: string; skill: string; since: string; evidence: string;
    expiresOn?: string | null | undefined; renewalLeadDays?: number | undefined;
  }): Promise<SkillsView> => recordSkill(ctx, input),
  setTechnicianSkillExpiry: (ctx: ServiceContext, input: {
    id: string; expiresOn: string | null; renewalLeadDays?: number | undefined;
  }): Promise<SkillsView> => setSkillExpiry(ctx, input),
  listExpiringTechnicianSkills: async (ctx: ServiceContext, input: { within?: number | undefined }) =>
    ({ expiring: await expiringSkills(ctx, input) }),
  endTechnicianSkill: (ctx: ServiceContext, input: { id: string; reason: string; endedOn?: string | undefined }): Promise<SkillsView> =>
    endSkill(ctx, input),
  listContinuingEducation: (ctx: ServiceContext, input: { technicianId: string }): Promise<CeView> => continuingEducation(ctx, input),
  logContinuingEducation: (ctx: ServiceContext, input: {
    technicianId: string; certificationTypeId: string; completedOn: string; hours: string;
    course: string; provider?: string | null | undefined; evidence?: string | null | undefined;
  }): Promise<CeView> => logContinuingEducation(ctx, input),
  removeContinuingEducation: (ctx: ServiceContext, input: { id: string }): Promise<CeView> => removeContinuingEducation(ctx, input),
  listPendingContinuingEducation: async (ctx: ServiceContext) => ({ pending: await pendingContinuingEducation(ctx) }),
  approveContinuingEducation: (ctx: ServiceContext, input: { id: string }): Promise<CeView> => approveContinuingEducation(ctx, input),
  declineContinuingEducation: (ctx: ServiceContext, input: { id: string; reason: string }): Promise<CeView> =>
    declineContinuingEducation(ctx, input),
  getJobSkills: (ctx: ServiceContext, input: { id: string }): Promise<JobSkillsView> => jobSkills(ctx, input),
  setJobSkills: (ctx: ServiceContext, input: { id: string; skills: string[] }): Promise<JobSkillsView> =>
    setJobSkills(ctx, input),
  dropJobSkill: (ctx: ServiceContext, input: { id: string; skill: string; reason: string }): Promise<JobSkillsView> =>
    dropSkill(ctx, input),
  restoreJobSkill: (ctx: ServiceContext, input: { id: string; skill: string }): Promise<JobSkillsView> =>
    restoreSkill(ctx, input),
} as const;
