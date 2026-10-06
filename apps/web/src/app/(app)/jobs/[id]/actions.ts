"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commercial, entitlements, files, jobs, jobBilling, visitChanges, ConflictError } from "@opentradesos/api/services";
import { money, type coverage } from "@opentradesos/core";
import { partiesFromForm } from "@/lib/job-parties";
import { completeVisit } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState, refused } from "@/lib/actions";
import { sourceFrom } from "@/lib/lead-source";
import { PART_ROWS } from "./parts";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function authorizeJob(_previous: unknown, form: FormData) {
  const jobId = String(form.get("jobId") ?? "");
  const amount = String(form.get("amount") ?? "").trim();
  try {
    await commercial.authorize(await ctx(), {
      jobId,
      /**
       * An empty amount is "approved, bill what it costs", which is a real
       * answer a client gives, rather than a zero ceiling that would refuse
       * every invoice on the job.
       */
      amount: amount === "" ? null : amount,
      ...(String(form.get("grantedByName") ?? "").trim()
        ? { grantedByName: String(form.get("grantedByName")).trim() } : {}),
      /**
       * Distinct field names on the two forms. They share a page, and a
       * shared name is ambiguous for anything that addresses the page by
       * one: a browser autofill, a screen reader, a script.
       */
      ...(String(form.get("authorizationReference") ?? "").trim()
        ? { externalReference: String(form.get("authorizationReference")).trim() } : {}),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/jobs/${jobId}`);
  return { done: true };
}

export async function setCoverage(_previous: unknown, form: FormData) {
  const jobId = String(form.get("jobId") ?? "");
  const source = String(form.get("source") ?? "");
  try {
    if (source === "") {
      await entitlements.clear(await ctx(), { jobId });
    } else {
      await entitlements.resolve(await ctx(), {
        jobId,
        source: source as coverage.CoverageSource,
        ...(String(form.get("coverageReference") ?? "").trim()
          ? { externalReference: String(form.get("coverageReference")).trim() } : {}),
        /**
         * The deductible or trade call fee: what the customer pays whatever
         * the coverage. Taken out of the covered amount once per visit.
         */
        ...(String(form.get("customerResponsibility") ?? "").trim()
          ? { customerResponsibility: String(form.get("customerResponsibility")).replace(/[$,\s]/g, "") } : {}),
      });
    }
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/jobs/${jobId}`);
  return { done: true };
}

export async function setPriority(_previous: unknown, form: FormData) {
  const jobId = String(form.get("jobId") ?? "");
  try {
    await jobs.update(await ctx(), { id: jobId, priority: Number(form.get("priority") ?? 0) });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/jobs/${jobId}`);
  return { done: true };
}

/**
 * The whole cast at once.
 *
 * `setParties` replaces rather than merges, so the form posts every role and
 * this rebuilds the list from it. Saving one role at a time would mean
 * reading the others back and resubmitting them, which is a lost update the
 * moment two people have the job open, and it would force the service to
 * merge, which leaves whoever used to be the approver still holding the role.
 */
export async function setJobParties(_previous: unknown, form: FormData) {
  const jobId = String(form.get("jobId") ?? "");
  const rows = partiesFromForm(
    (field) => {
      const value = form.get(field);
      return typeof value === "string" ? value : null;
    },
    String(form.get("customerId") ?? ""),
  );

  try {
    await commercial.setParties(await ctx(), { jobId, parties: rows });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/jobs/${jobId}`);
  return { done: true };
}

/**
 * FINISHING THE WORK, FROM THE OFFICE.
 *
 * Completing a visit was a technician's phone or `POST /v1/visits/{id}/complete`,
 * so a company whose technicians do not carry the app, or a visit the office
 * hears about by phone, could not be finished at all. The same service call
 * the API makes: the notes, what was used (as job lines, priced from the
 * price book), and the job finished when its last visit is.
 */
export async function completeVisitFromOffice(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const partsUsed: { priceBookItemId: string; quantity: string }[] = [];
  for (let i = 0; i < PART_ROWS; i += 1) {
    const item = field(form, `partItem${i}`);
    if (!item) continue;
    partsUsed.push({ priceBookItemId: item, quantity: field(form, `partQuantity${i}`) ?? "1" });
  }
  const result = await attempt(form, async () => {
    const input = parsed(completeVisit.input, {
      id: field(form, "visitId"),
      technicianNotes: field(form, "technicianNotes"),
      ...(partsUsed.length > 0 ? { partsUsed } : {}),
    });
    await jobs.complete(await ctx(), input);
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/**
 * Moving the job itself along its lifecycle: finishing a job that has no
 * visit left open, and reopening a finished one when the customer calls
 * back. Which moves are allowed is the service's rule (`canTransition`),
 * not this form's: a paid job does not reopen, and the refusal says so.
 */
export async function setJobStatus(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const status = field(form, "status");
  if (status !== "completed" && status !== "in_progress" && status !== "cancelled") return refused(form, "Nothing to do.");
  const cancelVisits = status === "cancelled" && field(form, "cancelVisits") === "1";
  const result = await attempt(form, async () => {
    await jobs.update(await ctx(), { id: jobId, status, ...(cancelVisits ? { cancelVisits } : {}) });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/**
 * Answering a customer's request to move or cancel a visit, from the job or
 * from the office queue. The service moves the visit, closes the task and
 * tells the customer; this only reports what it said.
 */
export async function approveVisitChange(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const answered = await visitChanges.approve(await ctx(), { id: field(form, "id") ?? "" });
    return {
      message: answered.notified === "queued"
        ? "Done, and the customer has been told."
        : `Done. The customer could not be told: ${answered.notified ?? "no way to reach them"}`,
    };
  });
  revalidatePath("/tasks");
  revalidatePath("/jobs");
  return result;
}

export async function declineVisitChange(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const answered = await visitChanges.decline(await ctx(), {
      id: field(form, "id") ?? "", response: field(form, "response"),
    });
    return {
      message: answered.notified === "queued"
        ? "Declined, and the customer has been told."
        : `Declined. The customer could not be told: ${answered.notified ?? "no way to reach them"}`,
    };
  });
  revalidatePath("/tasks");
  revalidatePath("/jobs");
  return result;
}

/**
 * Offering the customer a different time from the one they asked for. The
 * service sends it with a link to say yes or no and moves nothing.
 */
export async function proposeVisitChange(_previous: FormState, form: FormData): Promise<FormState> {
  const [date = "", arrivalWindowId = ""] = (field(form, "time") ?? "").split("|");
  const result = await attempt(form, async () => {
    const answered = await visitChanges.propose(await ctx(), {
      id: field(form, "id") ?? "", date, arrivalWindowId, response: field(form, "response"),
    });
    return {
      message: answered.notified === "queued"
        ? "Offered. The customer has been sent it with a link to say yes or no."
        : `Offered, but the customer could not be told: ${answered.notified ?? "no way to reach them"}`,
    };
  });
  revalidatePath("/tasks");
  revalidatePath("/jobs");
  return result;
}

/**
 * The office corrects where a job came from. Recorded as a declared touch on
 * the job and written to its columns as chosen; choosing nothing clears it.
 */
export async function setJobSource(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const picked = sourceFrom(form);
  const result = await attempt(form, async () => {
    await jobs.update(await ctx(), {
      id: jobId,
      ...(picked.campaignId ? { campaignId: picked.campaignId }
        : picked.channelId ? { channelId: picked.channelId }
          : { leadSource: null, channelId: null, campaignId: null }),
    });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/**
 * Show one job photograph on the customer's job link, or stop showing it.
 * Every photograph starts private; this is the decision to share one.
 */
export async function shareJobPhoto(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  return attempt(form, async () => {
    await files.shareWithCustomer(await ctx(), {
      attachmentId: field(form, "attachmentId") ?? "",
      shared: field(form, "shared") === "yes",
    });
    revalidatePath(`/jobs/${jobId}`);
  });
}

/** Read who is paying from the unit's warranty dates, and say so when it was out of warranty. */
export async function coverageFromUnit(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const result = await attempt(form, async () => {
    const found = await jobBilling.coverageFromEquipment(await ctx(), { jobId });
    return { message: found.resolved ? found.note : found.reason };
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/** The contract the job runs under, or none. Its cards price the job and its clocks start. */
export async function setJobContract(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const result = await attempt(form, async () => jobBilling.setContract(await ctx(), {
    jobId, contractId: field(form, "contractId") ?? null,
  }));
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/** Bill the job as the plan on the page says: one invoice per payer, all or none. */
export async function billThisJob(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const result = await attempt(form, async () => {
    const taxRate = field(form, "taxRate");
    const lineRates = (field(form, "lineRates") ?? "").split(",").filter(Boolean);
    const billed = await jobBilling.bill(await ctx(), {
      jobId, ...(taxRate ? { taxRate } : {}), ...(lineRates.length > 0 ? { lineRates } : {}),
    });
    return {
      message: billed.invoices.length === 1
        ? `Invoice ${billed.invoices[0]!.number} raised.`
        : `Invoices ${billed.invoices.map((i) => i.number).join(" and ")} raised, ${money.edit(money.money(billed.invoicedTotal))} in all.`,
    };
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}
