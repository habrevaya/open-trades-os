"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inspections } from "@opentradesos/api/services";
import { routes } from "@opentradesos/api/contracts";
import { attempt, field, parsed, refused, type FormState } from "@/lib/actions";

/**
 * A COMPANY'S OWN INSPECTION PROGRAMME, FROM THE SCREEN.
 *
 * The checkpoints come from the editor as one JSON list, parsed by the same
 * route schema the API uses, so the screen is exactly as strict as
 * `POST /v1/inspection-programs` and `POST /v1/inspection-programs/{id}/versions`.
 * Whether it can be filed is the service's to decide, and its sentence is
 * shown under the button.
 */
function common(form: FormData) {
  let checkpoints: unknown = [];
  try {
    checkpoints = JSON.parse(field(form, "checkpoints") ?? "[]");
  } catch {
    checkpoints = [];
  }
  const months = field(form, "frequencyMonths");
  const audience = field(form, "reportAudience") ?? "customer";
  return {
    name: field(form, "name") ?? "",
    standard: field(form, "standard") ?? null,
    reportAudience: audience,
    /** An authority's name means nothing on a report that only goes to the customer. */
    authorityName: audience === "customer" ? null : field(form, "authorityName") ?? null,
    frequencyMonths: months ? Number(months) : null,
    checkpoints,
    note: field(form, "note") ?? null,
  };
}

/**
 * A new programme: saved whole as version 1 ("Save the programme"), or kept
 * as a draft ("Save as a draft"), which is not checked and nobody can use. What
 * it takes the place of goes with publishing, so a draft does not send it.
 */
export async function writeProgramme(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const source = field(form, "copiedFrom");
  const draft = field(form, "intent") === "draft";
  const result = await attempt(form, async () => {
    const copiedFrom = source?.startsWith("pack:")
      ? { kind: "trade_pack", packId: source.split(":")[1], code: source.split(":")[2] }
      : source?.startsWith("program:") ? { kind: "program", programId: source.slice("program:".length) } : undefined;
    const replaces = !draft && form.get("replace") === "on" ? field(form, "replaces") : undefined;
    const row = await inspections.defineProgram(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(routes.defineInspectionProgram.input, {
        ...common(form),
        ...(copiedFrom ? { copiedFrom } : {}),
        ...(replaces ? { replaces } : {}),
        ...(draft ? { draft: true } : {}),
      }),
    );
    id = row.id;
  });
  if (id) {
    revalidatePath("/inspections");
    revalidatePath("/inspections/programmes");
    redirect(draft ? `/inspections/programmes/${id}?draft=saved` : `/inspections/programmes/${id}?published=1`);
  }
  return result;
}

/**
 * A draft, saved again or published. Publishing saves what is on the screen
 * first, so a refusal to publish (a range still missing, a name already
 * offered) never loses the edits: the draft is kept as typed, and the page
 * says why it could not be published.
 */
export async function saveOrPublishDraft(_previous: FormState, form: FormData): Promise<FormState> {
  const programId = field(form, "programId") ?? "";
  const publish = field(form, "intent") === "publish";
  const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
  const { note, ...content } = common(form);
  const saved = await attempt(form, async () => {
    await inspections.saveDraft(await ctx(), parsed(routes.saveInspectionProgramDraft.input, { id: programId, ...content }));
  });
  if (!saved?.done) return saved;
  revalidatePath("/inspections/programmes");
  if (!publish) redirect(`/inspections/programmes/${programId}?draft=saved`);

  const replaces = form.get("replace") === "on" ? field(form, "replaces") : undefined;
  const published = await attempt(form, async () => {
    await inspections.publishDraft(await ctx(), parsed(routes.publishInspectionProgramDraft.input, {
      id: programId, ...(replaces ? { replaces } : {}), note,
    }));
  });
  if (!published?.done) {
    return refused(form, `Your changes are saved in the draft. It was not published: ${published?.error ?? ""}`);
  }
  revalidatePath("/inspections");
  redirect(`/inspections/programmes/${programId}?published=1`);
}

/** Throw a draft away. A published programme is stopped being offered instead, and kept. */
export async function discardDraft(_previous: FormState, form: FormData): Promise<FormState> {
  const programId = field(form, "programId") ?? "";
  const result = await attempt(form, async () => {
    await inspections.discardDraft(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(routes.discardInspectionProgramDraft.input, { id: programId }),
    );
  });
  if (result?.done) {
    revalidatePath("/inspections/programmes");
    redirect("/inspections/programmes?discarded=1");
  }
  return result;
}

export async function publishVersion(_previous: FormState, form: FormData): Promise<FormState> {
  const programId = field(form, "programId") ?? "";
  const base = Number(field(form, "baseVersion"));
  let version: number | null = null;
  const result = await attempt(form, async () => {
    const row = await inspections.reviseProgram(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(routes.reviseInspectionProgram.input, { id: programId, baseVersion: base, ...common(form) }),
    );
    version = row.version;
  });
  if (version !== null && version === base) {
    return refused(form, "Nothing has changed since version " + base + ", so no new version was published.");
  }
  if (version !== null) {
    revalidatePath("/inspections");
    redirect(`/inspections/programmes/${programId}?published=${version}`);
  }
  return result;
}

/** Offer a programme to technicians again, or stop offering it. Kept either way, with every version. */
export async function setOffered(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "programId") ?? "";
  const result = await attempt(form, async () => {
    await inspections.setOffered(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(routes.setInspectionProgramOffered.input, { id, offered: field(form, "offered") === "yes" }),
    );
  });
  if (result?.done) {
    revalidatePath("/inspections/programmes");
    revalidatePath(`/inspections/programmes/${id}`);
    revalidatePath("/inspections");
  }
  return result;
}
