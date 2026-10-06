"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  ConflictError, projectApplications, projectChangeOrders, projectLiens, projectSchedule,
} from "@opentradesos/api/services";
import {
  addChangeOrderLine, applyChangeOrderScheduleDays, createProjectApplication, decideChangeOrder, recordProjectLienRecord,
  requestChangeOrder, sendChangeOrder, updateChangeOrder, updateProjectApplication, withdrawChangeOrder,
} from "@opentradesos/api/contracts";
import { attempt, field, parsed, refusalOf, type FormState } from "@/lib/actions";

/**
 * THE PROJECT'S DOCUMENTS, FROM THE OFFICE.
 *
 * Change orders, the schedule, applications for payment and notices and
 * waivers, each write the call its API route makes, parsed by that route's
 * own schema so the screen is exactly as strict as the API. Every refusal
 * is the service's sentence, shown under the form that caused it.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** "10" typed into a percentage box is the fraction "0.1" the services take. */
function fraction(percent: string | undefined): string | undefined {
  if (percent === undefined) return undefined;
  const value = Number(percent);
  if (!Number.isFinite(value)) return percent;
  return String(Math.round(value * 10_000) / 1_000_000);
}

export async function actOnChangeOrder(_previous: FormState, form: FormData): Promise<FormState> {
  const op = field(form, "op");
  const projectId = field(form, "projectId") ?? "";
  const changeOrderId = field(form, "changeOrderId") ?? "";
  const c = await ctx();
  let created: string | null = null;
  let link: string | null = null;
  let message: string | null = null;

  const result = await attempt(form, async () => {
    switch (op) {
      case "request": {
        const days = field(form, "scheduleDays");
        const made = await projectChangeOrders.request(c, parsed(requestChangeOrder.input, {
          projectId,
          title: field(form, "title"),
          description: field(form, "description") ?? null,
          requestedBy: field(form, "requestedBy") ?? null,
          reason: field(form, "reason") ?? null,
          phaseId: field(form, "phaseId") ?? null,
          scheduleDays: days === undefined ? null : Number(days),
        }));
        created = made.id;
        return;
      }
      case "update": {
        const days = field(form, "scheduleDays");
        await projectChangeOrders.update(c, parsed(updateChangeOrder.input, {
          id: changeOrderId,
          title: field(form, "title"),
          description: field(form, "description") ?? null,
          requestedBy: field(form, "requestedBy") ?? null,
          reason: field(form, "reason") ?? null,
          phaseId: field(form, "phaseId") ?? null,
          scheduleDays: days === undefined ? null : Number(days),
        }));
        return;
      }
      case "line": {
        const itemId = field(form, "priceBookItemId");
        await projectChangeOrders.addLine(c, parsed(addChangeOrderLine.input, {
          changeOrderId,
          priceBookItemId: itemId ?? null,
          name: itemId ? null : field(form, "name") ?? null,
          description: field(form, "description") ?? null,
          quantity: field(form, "quantity") ?? "1",
          unitPrice: itemId ? null : field(form, "unitPrice") ?? null,
          unitCost: itemId ? null : field(form, "unitCost") ?? null,
        }));
        return;
      }
      case "remove-line":
        await projectChangeOrders.removeLine(c, { changeOrderId, lineId: field(form, "lineId") ?? "" });
        return;
      case "send": {
        const sent = await projectChangeOrders.send(c, parsed(sendChangeOrder.input, {
          id: changeOrderId, channel: field(form, "channel") ?? "link",
        }));
        link = sent.url;
        message = sent.emailed
          ? "Emailed to the customer. The link is below as well."
          : sent.reason ?? "Copy the link below and send it to the customer.";
        return;
      }
      case "decide":
        await projectChangeOrders.decide(c, parsed(decideChangeOrder.input, {
          id: changeOrderId,
          decision: field(form, "decision"),
          signerName: field(form, "signerName") ?? null,
          reason: field(form, "reason") ?? null,
        }));
        return;
      case "withdraw":
        await projectChangeOrders.withdraw(c, parsed(withdrawChangeOrder.input, {
          id: changeOrderId, reason: field(form, "reason") ?? "",
        }));
        return;
      case "apply-days":
        /** The key is what the person was shown; the service refuses it if the schedule moved since. */
        await projectSchedule.applyChangeOrderDays(c, parsed(applyChangeOrderScheduleDays.input, {
          id: changeOrderId,
          phaseId: field(form, "phaseId"),
          proposalKey: field(form, "proposalKey"),
        }));
        revalidatePath(`/projects/${projectId}/schedule`);
        return;
      default:
        throw new ConflictError("Nothing to do.");
    }
  });
  if (created) redirect(`/projects/${projectId}/change-orders/${created}`);
  revalidatePath(`/projects/${projectId}`);
  if (result?.error) return result;
  return { done: true, ...(message ? { message } : {}), ...(link ? { link } : {}) };
}

/**
 * A phase dragged on the timeline. Called from the timeline itself rather
 * than a form, so it answers with the refusal as a sentence for the bar to
 * show, never a thrown error.
 */
export async function dragPhase(
  projectId: string, phaseId: string, startsOn: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await projectSchedule.move(await ctx(), { id: phaseId, startsOn });
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return { ok: false, message };
  }
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

export async function setPhaseDates(_previous: FormState, form: FormData): Promise<FormState> {
  const projectId = field(form, "projectId") ?? "";
  const result = await attempt(form, async () => {
    await projectSchedule.setDates(await ctx(), {
      id: field(form, "phaseId") ?? "",
      startsOn: field(form, "startsOn") ?? null,
      endsOn: field(form, "endsOn") ?? null,
    });
  });
  revalidatePath(`/projects/${projectId}/schedule`);
  return result;
}

export async function actOnApplication(_previous: FormState, form: FormData): Promise<FormState> {
  const op = field(form, "op");
  const projectId = field(form, "projectId") ?? "";
  const applicationId = field(form, "applicationId") ?? "";
  const c = await ctx();
  let created: string | null = null;
  let deleted = false;
  const result = await attempt(form, async () => {
    switch (op) {
      case "create": {
        const made = await projectApplications.create(c, parsed(createProjectApplication.input, {
          projectId,
          periodTo: field(form, "periodTo"),
          periodFrom: field(form, "periodFrom") ?? null,
          retainageRate: fraction(field(form, "retainagePercent")) ?? null,
          storedRetainageRate: fraction(field(form, "storedRetainagePercent")) ?? null,
        }));
        created = made.id;
        return;
      }
      case "save": {
        /**
         * One row per line, posted as `work.<id>`, `stored.<id>` and
         * `percent.<id>`. A percentage typed on a line wins over the dollars
         * beside it, because that is the box somebody filled in last.
         */
        const ids = form.getAll("lineId").filter((v): v is string => typeof v === "string");
        await projectApplications.updateDraft(c, parsed(updateProjectApplication.input, {
          id: applicationId,
          periodFrom: field(form, "periodFrom") ?? null,
          periodTo: field(form, "periodTo"),
          retainageRate: fraction(field(form, "retainagePercent")),
          storedRetainageRate: fraction(field(form, "storedRetainagePercent")),
          retainageReleased: field(form, "retainageReleased") ?? "0",
          notes: field(form, "notes") ?? null,
          lines: ids.map((id) => {
            const percent = field(form, `percent.${id}`);
            return percent !== undefined
              ? { id, percentComplete: percent, storedNow: field(form, `stored.${id}`) ?? "0" }
              : { id, workThisPeriod: field(form, `work.${id}`) ?? "0", storedNow: field(form, `stored.${id}`) ?? "0" };
          }),
        }));
        return;
      }
      case "raise":
        await projectApplications.raise(c, { id: applicationId });
        return;
      case "delete":
        await projectApplications.removeDraft(c, { id: applicationId });
        deleted = true;
        return;
      default:
        throw new ConflictError("Nothing to do.");
    }
  });
  if (created) redirect(`/projects/${projectId}/applications/${created}`);
  if (deleted && !result?.error) redirect(`/projects/${projectId}/applications`);
  revalidatePath(`/projects/${projectId}/applications`);
  return result;
}

export async function actOnLienRecords(_previous: FormState, form: FormData): Promise<FormState> {
  const op = field(form, "op");
  const projectId = field(form, "projectId") ?? "";
  const c = await ctx();
  const result = await attempt(form, async () => {
    if (op === "delete") {
      await projectLiens.remove(c, { id: field(form, "recordId") ?? "" });
      return;
    }
    const kind = field(form, "kind");
    const waiver = kind === "waiver";
    const file = form.get("document");
    const document = file instanceof File && file.size > 0
      ? {
          fileName: file.name || "document",
          contentType: file.type || undefined,
          bytes: Buffer.from(await file.arrayBuffer()).toString("base64"),
        }
      : undefined;
    await projectLiens.record(c, parsed(recordProjectLienRecord.input, {
      projectId,
      kind,
      direction: field(form, "direction"),
      condition: waiver ? field(form, "condition") ?? null : null,
      scope: waiver ? field(form, "scope") ?? null : null,
      title: field(form, "title"),
      partyName: field(form, "partyName"),
      onDate: field(form, "onDate"),
      throughDate: field(form, "throughDate") ?? null,
      amount: field(form, "amount") ?? null,
      invoiceId: field(form, "invoiceId") ?? null,
      notes: field(form, "notes") ?? null,
      ...(document ? { document } : {}),
    }));
  });
  revalidatePath(`/projects/${projectId}/liens`);
  return result;
}
