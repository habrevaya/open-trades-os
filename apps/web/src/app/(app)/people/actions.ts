"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { peopleRecords } from "@opentradesos/api/services";
import {
  addEmergencyContact, addOnboardingTemplateItem, logContinuingEducation, recordTechnicianSkill,
  setEmploymentRecord, setOnboardingLine,
} from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * EVERYTHING THE PEOPLE SCREENS WRITE, each through its service and the
 * route's own parsing. Refusals are the service's own sentences: a contact
 * with no number, an end before a start, a skill with no evidence.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const refresh = (membershipId?: string) => {
  revalidatePath("/people");
  revalidatePath("/people/onboarding");
  if (membershipId) revalidatePath(`/people/${membershipId}`);
};

export async function addTemplateItemAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const role = field(form, "role") ?? "";
    await peopleRecords.addTemplateItem(await ctx(), parsed(addOnboardingTemplateItem.input, {
      ...(role.startsWith("custom:") ? { roleId: role.slice(7) } : { role }),
      kind: field(form, "kind"),
      label: field(form, "label") ?? "",
      required: form.get("required") !== null,
    }));
  });
  if (state?.done) refresh();
  return state;
}

export async function removeTemplateItemAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await peopleRecords.removeTemplateItem(await ctx(), { id: String(form.get("id") ?? "") });
  });
  if (state?.done) refresh();
  return state;
}

export async function startOnboardingAction(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const state = await attempt(form, async () => {
    const result = await peopleRecords.startOnboarding(await ctx(), { membershipId });
    return { message: result.added === 0 ? "Nothing new on the checklist." : `${result.added} lines added.` };
  });
  if (state?.done) refresh(membershipId);
  return state;
}

export async function setOnboardingLineAction(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.setOnboardingLine(await ctx(), parsed(setOnboardingLine.input, {
      id: String(form.get("id") ?? ""),
      done: form.get("done") === "true",
      ...(form.has("note") ? { note: field(form, "note") ?? null } : {}),
    }));
  });
  if (state?.done) refresh(membershipId);
  return state;
}

export async function addContactAction(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.addEmergencyContact(await ctx(), parsed(addEmergencyContact.input, {
      membershipId,
      name: field(form, "name") ?? "",
      relationship: field(form, "relationship") ?? null,
      phone: field(form, "phone") ?? "",
      alternatePhone: field(form, "alternatePhone") ?? null,
      note: field(form, "note") ?? null,
    }));
  });
  if (state?.done) refresh(membershipId);
  return state;
}

export async function removeContactAction(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.removeEmergencyContact(await ctx(), { id: String(form.get("id") ?? "") });
  });
  if (state?.done) refresh(membershipId);
  return state;
}

export async function setEmploymentAction(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.setEmployment(await ctx(), parsed(setEmploymentRecord.input, {
      membershipId,
      jobTitle: field(form, "jobTitle") ?? null,
      startedOn: field(form, "startedOn"),
      endedOn: field(form, "endedOn") ?? null,
      employmentType: field(form, "employmentType"),
      payType: field(form, "payType"),
      payrollReference: field(form, "payrollReference") ?? null,
    }));
  });
  if (state?.done) refresh(membershipId);
  return state;
}

export async function recordSkillAction(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.recordSkill(await ctx(), parsed(recordTechnicianSkill.input, {
      technicianId: String(form.get("technicianId") ?? ""),
      skill: field(form, "skill") ?? "",
      since: field(form, "since"),
      evidence: field(form, "evidence") ?? "",
    }));
  });
  if (state?.done) refresh(membershipId);
  return state;
}

export async function endSkillAction(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.endSkill(await ctx(), { id: String(form.get("id") ?? ""), reason: field(form, "reason") ?? "" });
  });
  if (state?.done) refresh(membershipId);
  return state;
}

export async function logCeAction(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.logContinuingEducation(await ctx(), parsed(logContinuingEducation.input, {
      technicianId: String(form.get("technicianId") ?? ""),
      certificationTypeId: field(form, "certificationTypeId"),
      completedOn: field(form, "completedOn"),
      hours: field(form, "hours") ?? "",
      course: field(form, "course") ?? "",
      provider: field(form, "provider") ?? null,
      evidence: field(form, "evidence") ?? null,
    }));
  });
  if (state?.done) refresh(membershipId);
  return state;
}
