"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { compliance } from "@opentradesos/api/services";

export type ComplianceState = { done?: boolean; error?: string } | null;

const text = (form: FormData, key: string): string | null => {
  const value = String(form.get(key) ?? "").trim();
  return value === "" ? null : value;
};

/**
 * Documents and filings, through the handlers their API routes use. The
 * refusals are the module's: an acknowledgement with no reference, a
 * submission with nothing kept of what was filed, a withdrawal with no
 * reason, a resubmission of a filing that was accepted.
 */
export async function act(_previous: ComplianceState, form: FormData): Promise<ComplianceState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");
  try {
    switch (op) {
      case "register":
        await compliance.handlers.registerComplianceDocument(ctx, {
          kind: String(form.get("kind") ?? "").trim(),
          name: String(form.get("name") ?? "").trim(),
          reference: text(form, "reference"),
          issuerName: text(form, "issuerName"),
          expiresOn: text(form, "expiresOn"),
          requiredForWork: form.get("requiredForWork") === "on",
        });
        break;
      case "renew":
        await compliance.handlers.renewComplianceDocument(ctx, {
          id,
          kind: String(form.get("kind") ?? ""),
          name: String(form.get("name") ?? ""),
          reference: text(form, "reference"),
          expiresOn: text(form, "expiresOn"),
          requiredForWork: form.get("requiredForWork") === "true",
        });
        break;
      case "withdraw":
        await compliance.handlers.withdrawComplianceDocument(ctx, { id, reason: String(form.get("reason") ?? "").trim() });
        break;
      case "open":
        await compliance.handlers.openRegulatorySubmission(ctx, {
          kind: String(form.get("kind") ?? ""),
          dueOn: String(form.get("dueOn") ?? ""),
          periodStart: text(form, "periodStart"),
          periodEnd: text(form, "periodEnd"),
        });
        break;
      case "advance": {
        const to = String(form.get("to") ?? "") as "prepared" | "submitted" | "acknowledged" | "rejected" | "waived";
        const said = text(form, "said");
        await compliance.handlers.advanceRegulatorySubmission(ctx, {
          id, to,
          ...(to === "acknowledged" && said ? { reference: said } : {}),
          ...((to === "rejected" || to === "waived") && said ? { reason: said } : {}),
          /** What was filed, kept in the filer's own words when there is no file. */
          ...(to === "submitted" && said ? { payload: { filed: said } } : {}),
        });
        break;
      }
      case "resubmit":
        await compliance.handlers.resubmitRegulatorySubmission(ctx, { id });
        break;
      default:
        return { error: "Nothing to do." };
    }
  } catch (error) {
    if (error instanceof Error && ["ConflictError", "NotFoundError", "UnprocessableError", "PermissionError"].includes(error.name)) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath("/compliance");
  return { done: true };
}
