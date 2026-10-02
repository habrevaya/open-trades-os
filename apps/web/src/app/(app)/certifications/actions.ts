"use server";

import { refused, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { people } from "@opentradesos/api/services";

export type CertState = FormState;

const text = (form: FormData, key: string): string | null => {
  const value = String(form.get(key) ?? "").trim();
  return value === "" ? null : value;
};

/**
 * Every certification write, through the handler its API route uses. The
 * refusals are the module's own: an expiring type recorded with no expiry
 * and no default validity, a revoked certification switched back on, a
 * suspension with no reason.
 */
export async function act(_previous: CertState, form: FormData): Promise<CertState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  try {
    switch (op) {
      case "type": {
        const months = text(form, "defaultValidMonths");
        const lead = text(form, "renewalLeadDays");
        await people.handlers.defineCertificationType(ctx, {
          code: String(form.get("code") ?? "").trim(),
          name: String(form.get("name") ?? "").trim(),
          authority: text(form, "authority"),
          grantsSkills: (text(form, "grantsSkills") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          expires: form.get("expires") === "on",
          defaultValidMonths: months === null ? null : Number(months),
          ...(lead === null ? {} : { renewalLeadDays: Number(lead) }),
        });
        break;
      }
      case "record":
        await people.handlers.recordCertification(ctx, {
          technicianId: String(form.get("technicianId") ?? ""),
          certificationTypeId: String(form.get("certificationTypeId") ?? ""),
          reference: text(form, "reference"),
          issuedOn: text(form, "issuedOn"),
          expiresOn: text(form, "expiresOn"),
        });
        break;
      case "verify":
        await people.handlers.verifyCertification(ctx, { id: String(form.get("id") ?? ""), note: text(form, "note") });
        break;
      case "status":
        await people.handlers.setCertificationStatus(ctx, {
          id: String(form.get("id") ?? ""),
          status: String(form.get("status") ?? "") as "active",
          reason: text(form, "reason"),
        });
        break;
      default:
        return refused(form, "Nothing to do.");
    }
  } catch (error) {
    if (error instanceof Error && ["ConflictError", "NotFoundError", "UnprocessableError", "PermissionError"].includes(error.name)) {
      return refused(form, error.message);
    }
    throw error;
  }
  revalidatePath("/certifications");
  return { done: true };
}
