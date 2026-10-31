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

export async function writeProgramme(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const source = field(form, "copiedFrom");
  const result = await attempt(form, async () => {
    const copiedFrom = source?.startsWith("pack:")
      ? { kind: "trade_pack", packId: source.split(":")[1], code: source.split(":")[2] }
      : source?.startsWith("program:") ? { kind: "program", programId: source.slice("program:".length) } : undefined;
    const replaces = form.get("replace") === "on" ? field(form, "replaces") : undefined;
    const row = await inspections.defineProgram(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(routes.defineInspectionProgram.input, {
        ...common(form),
        ...(copiedFrom ? { copiedFrom } : {}),
        ...(replaces ? { replaces } : {}),
      }),
    );
    id = row.id;
  });
  if (id) {
    revalidatePath("/inspections");
    redirect(`/inspections/programmes/${id}?published=1`);
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
