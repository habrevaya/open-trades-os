"use server";

import { attempt, field, fields, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@opentradesos/api/services";
import type { campaign as cp } from "@opentradesos/core";

export type CampaignState = FormState;

/**
 * The audience, read off a form.
 *
 * ONE RULE PER SUBMITTED KIND, and only the kinds that were ticked. The nine
 * rules are a closed set in core, so this does not validate them: it assembles
 * what the boxes say and lets `checkAudience` refuse the rest, which reports ALL
 * the refusals rather than the first. Building a rule the union does not have is
 * a type error here rather than a runtime surprise there.
 *
 * An empty audience is not assembled into "everybody". It is passed through as
 * empty and refused, because that refusal is the most valuable one in the module:
 * no rules means the whole customer list, which is how a company's one registered
 * number gets flagged by a carrier and its domain blocked in an afternoon.
 */
function audienceFrom(form: FormData): cp.AudienceRule[] {
  const picked = new Set(fields(form, "rule"));
  const rules: cp.AudienceRule[] = [];
  const whole = (name: string, fallback: number) => {
    const raw = field(form, name);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(parsed) ? parsed : fallback;
  };

  if (picked.has("no_job_since")) {
    rules.push({ kind: "no_job_since", days: whole("no_job_since_days", 0) });
  }
  if (picked.has("equipment_older_than")) {
    const category = field(form, "equipment_category");
    rules.push({
      kind: "equipment_older_than",
      years: whole("equipment_years", 0),
      ...(category ? { category } : {}),
    });
  }
  if (picked.has("agreement_ending_within")) {
    rules.push({ kind: "agreement_ending_within", days: whole("agreement_days", 0) });
  }
  if (picked.has("agreement_lapsed")) rules.push({ kind: "agreement_lapsed" });
  if (picked.has("no_agreement")) rules.push({ kind: "no_agreement" });
  if (picked.has("postal_code_in")) {
    rules.push({ kind: "postal_code_in", codes: listOf(form, "postal_codes") });
  }
  if (picked.has("tagged_any")) {
    rules.push({ kind: "tagged_any", tags: listOf(form, "tags") });
  }
  if (picked.has("open_deficiency")) rules.push({ kind: "open_deficiency" });
  if (picked.has("served_at_least_once")) rules.push({ kind: "served_at_least_once" });
  return rules;
}

/** A comma separated box, split and trimmed. Empties dropped, not kept as "". */
const listOf = (form: FormData, name: string): string[] =>
  (field(form, name) ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");

/**
 * Every campaign write, through its service handler.
 *
 * Nothing here decides what is allowed. The refusals are the module's: an
 * audience with no rules, a rule that contradicts another, a body over the
 * carrier's limit, a subject on a text, an edit after it has gone, a send with no
 * registered number.
 */
export async function act(_previous: CampaignState, form: FormData): Promise<CampaignState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "create": {
        const channel = form.get("channel") === "email" ? "email" as const : "sms" as const;
        const created = await campaigns.create(ctx, {
          name: String(form.get("name") ?? ""),
          channel,
          audience: audienceFrom(form),
          body: String(form.get("body") ?? ""),
          subject: channel === "email" ? (field(form, "subject") ?? null) : null,
          ...(field(form, "utmCampaign") ? { utmCampaign: field(form, "utmCampaign")! } : {}),
        });
        return { message: `"${created.name}" is a draft. Read the audience, then send it.` };
      }
      case "send": {
        /**
         * The send report is handed back as the form's message, because it is the
         * one thing an owner must see and the row they pressed the button on
         * cannot carry it: a cap can leave most of the audience for tomorrow.
         */
        const report = await campaigns.send(ctx, { id });
        const left = report.remaining > 0 ? `, ${report.remaining} left for tomorrow` : "";
        return {
          message: `${report.queued} queued, ${report.skipped} not sent${left}.`,
        };
      }
      case "cancel":
        await campaigns.cancel(ctx, { id, ...(field(form, "reason") ? { reason: field(form, "reason")! } : {}) });
        return;
      case "delete":
        await campaigns.remove(ctx, { id });
        return;
      default:
        throw new Error(`Unknown campaign operation: ${op}`);
    }
  });

  if (state?.done) revalidatePath("/marketing/campaigns");
  return state;
}
