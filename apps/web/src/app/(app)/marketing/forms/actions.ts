"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { forms } from "@opentradesos/api/services";
import { saveForm as saveFormRoute } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * The fields a new form starts with: the ones every trades lead form has,
 * a consent box that says exactly what it agrees to, and the honeypot. The
 * office edits them from there; a blank form would make everybody build the
 * same five fields by hand.
 */
const STARTER = [
  { key: "name", label: "Your name", type: "text", required: true },
  { key: "phone", label: "Mobile number", type: "phone", required: true },
  { key: "email", label: "Email", type: "email", required: false },
  { key: "address", label: "Where is the work?", type: "service_address", required: false },
  { key: "details", label: "What do you need?", type: "long_text", required: false },
  {
    key: "texts_ok", label: "You may text me about offers and seasonal maintenance.", type: "consent",
    required: false, consentFor: { channel: "sms", purpose: "marketing" },
    help: "Reply STOP at any time. Message and data rates may apply.",
  },
  { key: "website", label: "Leave this empty", type: "honeypot", required: false },
];

export async function startForm(_previous: FormState, form: FormData): Promise<FormState> {
  const slug = (field(form, "slug") ?? "").trim().toLowerCase();
  const result = await attempt(form, async () => {
    const input = parsed(saveFormRoute.input, {
      slug, title: field(form, "title") ?? "", fields: STARTER, minimumFillSeconds: 3,
    });
    await forms.save(await ctx(), { ...input, fields: input.fields as Parameters<typeof forms.save>[1]["fields"] });
  });
  if (result?.error) return result;
  revalidatePath("/marketing/forms");
  redirect(`/marketing/forms/${encodeURIComponent(slug)}`);
}

/**
 * The whole form, as the builder drew it.
 *
 * Posted as JSON because the field list is a list somebody reorders, and
 * parsed through the route's own schema, so the screen is exactly as strict
 * as the API. Core's `checkForm` then refuses what would make the form
 * unusable, in its own words.
 */
export async function saveForm(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    let fields: unknown = [];
    try {
      fields = JSON.parse(field(form, "fields") ?? "[]");
    } catch {
      fields = [];
    }
    const seconds = field(form, "minimumFillSeconds");
    const input = parsed(saveFormRoute.input, {
      slug: field(form, "slug") ?? "",
      title: field(form, "title") ?? "",
      source: field(form, "source") ?? undefined,
      fields,
      ...(seconds ? { minimumFillSeconds: Number(seconds) } : {}),
      settings: {
        thankYou: field(form, "thankYou") ?? undefined,
        confirmationText: field(form, "confirmationText") ?? undefined,
        confirmationEmailSubject: field(form, "confirmationEmailSubject") ?? undefined,
        confirmationEmailBody: field(form, "confirmationEmailBody") ?? undefined,
      },
    });
    await forms.save(await ctx(), { ...input, fields: input.fields as Parameters<typeof forms.save>[1]["fields"] });
    return { message: "Saved. The hosted page shows it now." };
  });
  revalidatePath("/marketing/forms");
  return result;
}
