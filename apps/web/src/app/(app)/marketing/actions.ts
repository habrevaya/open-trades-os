"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  acquisition, marketing, leadIntake, leadConnectors, customers, jobs, properties, ConflictError,
} from "@opentradesos/api/services";
import {
  createChannel as createChannelRoute, updateChannel as updateChannelRoute,
  createTrackingCampaign as createCampaignRoute, updateTrackingCampaign as updateCampaignRoute,
  setMarketingSettings, recordSpend as recordSpendRoute, importSpendFile, declineLeadOffer,
  createLeadConnector, testLeadMapping, createCustomer as createCustomerRoute, createJob,
} from "@opentradesos/api/contracts";
import { attempt, field, parsed, refused, type FormState } from "@/lib/actions";
import { sourceFrom } from "@/lib/lead-source";

/**
 * EVERY MARKETING FORM, THROUGH ITS SERVICE
 *
 * Each action parses its input with the route's own schema, so a screen is
 * exactly as strict as the API, and decides nothing: the refusals (a channel
 * with no catalogue key, a fixed price with no end date, an offer that has
 * expired) are the services' sentences, shown under the form.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/* ------------------------------------------------------------- channels */

export async function createChannel(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(createChannelRoute.input, {
      name: field(form, "name") ?? "", sourceKey: field(form, "sourceKey") ?? "",
    });
    const made = await acquisition.createChannel(await ctx(), input);
    return { message: `${made.name} added.` };
  });
  revalidatePath("/marketing/channels");
  return result;
}

export async function updateChannel(_previous: FormState, form: FormData): Promise<FormState> {
  const archive = field(form, "archive");
  const result = await attempt(form, async () => {
    const input = parsed(updateChannelRoute.input, {
      id: field(form, "id"),
      ...(field(form, "name") ? { name: field(form, "name") } : {}),
      ...(field(form, "sourceKey") ? { sourceKey: field(form, "sourceKey") } : {}),
      ...(archive ? { archived: archive === "yes" } : {}),
    });
    await acquisition.updateChannel(await ctx(), input);
  });
  revalidatePath("/marketing/channels");
  return result;
}

export async function saveSettings(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(setMarketingSettings.input, {
      attributionModel: field(form, "attributionModel"),
      requireLeadSource: form.get("requireLeadSource") === "yes",
    });
    await acquisition.setSettings(await ctx(), input);
    return { message: "Saved." };
  });
  revalidatePath("/marketing/channels");
  return result;
}

/* ---------------------------------------------------- tracking campaigns */

function campaignFields(form: FormData) {
  const nullable = (name: string) => field(form, name) ?? null;
  return {
    name: field(form, "name"),
    startsOn: nullable("startsOn"),
    endsOn: nullable("endsOn"),
    costModel: field(form, "costModel") ?? "recorded",
    costAmount: nullable("costAmount"),
    budget: nullable("budget"),
    utmCampaign: nullable("utmCampaign"),
    notes: nullable("notes"),
  };
}

export async function createTrackingCampaign(_previous: FormState, form: FormData): Promise<FormState> {
  let createdId: string | null = null;
  const result = await attempt(form, async () => {
    const input = parsed(createCampaignRoute.input, { channelId: field(form, "channelId"), ...campaignFields(form) });
    createdId = (await acquisition.createCampaign(await ctx(), input)).id;
  });
  if (!createdId) return result;
  redirect(`/marketing/tracking/${createdId}`);
}

export async function updateTrackingCampaign(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const archive = field(form, "archive");
  const result = await attempt(form, async () => {
    const input = parsed(updateCampaignRoute.input, archive
      ? { id, archived: archive === "yes" }
      : { id, channelId: field(form, "channelId"), ...campaignFields(form) });
    await acquisition.updateCampaign(await ctx(), input);
    return { message: "Saved." };
  });
  revalidatePath(`/marketing/tracking/${id}`);
  return result;
}

/* ----------------------------------------------------------------- spend */

export async function recordSpend(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(recordSpendRoute.input, {
      ...sourceFrom(form, "for"),
      spentOn: field(form, "spentOn"),
      amount: field(form, "amount"),
      ...(field(form, "label") ? { campaign: field(form, "label") } : {}),
    });
    await marketing.recordSpend(await ctx(), input);
    return { message: "Recorded. Typing the same day again replaces it." };
  });
  revalidatePath("/marketing/spend");
  return result;
}

export async function removeSpend(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await marketing.removeSpend(await ctx(), { id: field(form, "id") ?? "" });
  });
  revalidatePath("/marketing/spend");
  return result;
}

/**
 * An ads platform's export, uploaded as a file. Read as text here and handed
 * to the same import the API offers, with the channel or campaign every row
 * belongs to, because a Google Ads export names Google nowhere in it.
 */
export async function uploadSpend(_previous: FormState, form: FormData): Promise<FormState> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return refused(form, "Choose the export file to upload.");
  const text = await file.text();
  const result = await attempt(form, async () => {
    const input = parsed(importSpendFile.input, { provider: "spend_csv", ...sourceFrom(form, "for"), text });
    const outcome = await leadIntake.importSpendFile(await ctx(), input);
    const refusals = [...outcome.refused.map((r) => `row ${r.row}: ${r.reason}`), ...outcome.skipped.map((s) => `line ${s.line}: ${s.reason}`)];
    return {
      message: `${outcome.accepted} day${outcome.accepted === 1 ? "" : "s"} loaded.`
        + (refusals.length > 0 ? ` Not loaded: ${refusals.slice(0, 5).join("; ")}${refusals.length > 5 ? ", and more" : ""}.` : ""),
    };
  });
  revalidatePath("/marketing/spend");
  return result;
}

/* ----------------------------------------------------------- lead offers */

export async function acceptOffer(_previous: FormState, form: FormData): Promise<FormState> {
  let jobId: string | null = null;
  const result = await attempt(form, async () => {
    jobId = (await leadIntake.acceptOffer(await ctx(), { id: field(form, "id") ?? "" })).jobId;
  });
  if (!jobId) return result;
  redirect(`/jobs/${jobId}`);
}

export async function declineOffer(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(declineLeadOffer.input, {
      id: field(form, "id"), reason: field(form, "reason"),
      ...(field(form, "note") ? { note: field(form, "note") } : {}),
    });
    await leadIntake.declineOffer(await ctx(), input);
  });
  revalidatePath("/marketing/leads");
  return result;
}

/* -------------------------------------------------------- lead connectors */

/** The field map, one box per field the product can take, left blank when the sender's own name is used. */
function fieldMapFrom(form: FormData): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("map.") && typeof value === "string" && value.trim() !== "") {
      map[key.slice(4)] = value.trim();
    }
  }
  return map;
}

export async function createConnector(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(createLeadConnector.input, {
      source: (field(form, "source") ?? "").toLowerCase(),
      displayName: field(form, "displayName"),
      ...sourceFrom(form, "channel"),
      fieldMap: fieldMapFrom(form),
    });
    const made = await leadConnectors.create(await ctx(), input);
    return {
      /**
       * Where the secret goes depends on the deployment's store. With the
       * database store it is already kept, encrypted, as it was minted; with
       * the environment store it goes in this company's own variable, never
       * one with the bare name, which the server does not read.
       */
      message: made.secretEnvironmentVariable
        ? `Set up. Give the sender the address ending ${made.webhookPath}, and set the environment variable ${made.secretEnvironmentVariable} on the server to the secret below.`
        : `Set up. Give the sender the address ending ${made.webhookPath} and the secret below. It is already kept, encrypted, as ${made.secretRef}.`,
      secret: { value: made.secret, caption: "The signing secret. It is shown once: copy it now." },
    };
  });
  revalidatePath("/marketing/leads/connectors");
  return result;
}

export async function testConnectorMapping(_previous: FormState, form: FormData): Promise<FormState> {
  let sample: Record<string, unknown>;
  try {
    const parsedSample: unknown = JSON.parse(field(form, "sample") ?? "");
    if (!parsedSample || typeof parsedSample !== "object" || Array.isArray(parsedSample)) throw new Error();
    sample = parsedSample as Record<string, unknown>;
  } catch {
    return refused(form, "Paste one lead exactly as the sender posts it, as JSON.");
  }
  return attempt(form, async () => {
    const input = parsed(testLeadMapping.input, {
      ...(field(form, "id") ? { id: field(form, "id") } : { fieldMap: fieldMapFrom(form) }),
      sample,
    });
    const verdict = await leadConnectors.testMapping(await ctx(), input);
    const got = verdict.fields.filter((f) => f.value).map((f) => `${f.label}: ${f.value}`).join(", ");
    return {
      message: verdict.wouldBeAccepted
        ? `This lead would be taken. ${got}.`
        : `This lead would be refused. ${verdict.reason ?? ""} What came out: ${got || "nothing"}.`,
    };
  });
}

/* ----------------------------------------------- a call, into a customer */

/**
 * "Create a customer and a job from this call", in the two ordinary steps a
 * CSR would take: the customer (whose phone claims the call and every call
 * before it from that number) and then the job, which names the call so the
 * two are linked and the job is credited to the call's campaign.
 */
export async function bookFromCall(_previous: FormState, form: FormData): Promise<FormState> {
  const callId = field(form, "callId") ?? "";
  const service = await ctx();
  let jobId: string | null = null;
  const result = await attempt(form, async () => {
    let customerId = field(form, "customerId");
    let propertyId = field(form, "propertyId");
    if (!customerId) {
      const input = parsed(createCustomerRoute.input, {
        type: "residential",
        name: field(form, "name") ?? "",
        ...(field(form, "phone") ? { phone: field(form, "phone") } : {}),
        ...(field(form, "email") ? { email: field(form, "email") } : {}),
        property: {
          address: {
            line1: field(form, "line1") ?? "", city: field(form, "city") ?? "",
            state: field(form, "state") ?? "", postalCode: field(form, "postalCode") ?? "", country: "US",
          },
        },
      });
      const created = await customers.create(service, input);
      customerId = created.id as string;
      const addresses = await properties.list(service, { limit: 1, customerId });
      propertyId = addresses.data[0]?.id;
    }
    if (!propertyId) throw new ConflictError("The customer has no address, and a job needs one.");
    const job = await jobs.create(service, parsed(createJob.input, {
      customerId, propertyId, callId,
      summary: field(form, "summary") ?? "",
      ...(field(form, "customerComplaint") ? { customerComplaint: field(form, "customerComplaint") } : {}),
    }));
    jobId = job.id as string;
  });
  if (!jobId) return result;
  redirect(`/jobs/${jobId}`);
}
