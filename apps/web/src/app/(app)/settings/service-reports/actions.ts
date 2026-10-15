"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { serviceReports } from "@opentradesos/api/services";
import { attempt, field, fields, type FormState } from "@/lib/actions";

/**
 * Which of a template's fields a technician must fill in. The rest of each
 * field is kept as it is, read back from the template rather than from the
 * form, so ticking a box cannot change a field's kind, its range or whether a
 * regulator asks for it.
 */
export async function saveRequired(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const id = field(form, "templateId") ?? "";
  const required = new Set(fields(form, "required"));
  const result = await attempt(form, async () => {
    const template = (await serviceReports.listTemplates(ctx)).find((t) => t.id === id);
    if (!template) return { message: "That template is not here any more." };
    await serviceReports.updateTemplate(ctx, {
      id,
      fields: template.fields.map((f) => {
        const { required: _was, ...rest } = f;
        void _was;
        return required.has(f.key) ? { ...rest, required: true } : rest;
      }),
    });
    return { message: "Saved. Reports written from now on are held to it." };
  });
  revalidatePath("/settings/service-reports");
  return result;
}
