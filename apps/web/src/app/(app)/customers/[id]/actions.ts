"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { comms, consent, contacts, customerLifecycle, portal, customers, ConflictError, NotFoundError } from "@opentradesos/api/services";
import { issuePortalGrant } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState, refused } from "@/lib/actions";
import { sourceFrom } from "@/lib/lead-source";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Record that somebody agreed to marketing messages.
 *
 * `customerId` is not taken from the form. The address is what consent is
 * about and the customer is a convenience link, and trusting a client to say
 * which customer a consent row belongs to is a field somebody can retarget.
 */
export async function grantMarketing(_previous: unknown, form: FormData) {
  try {
    await consent.grant(await ctx(), {
      address: String(form.get("address") ?? ""),
      channel: "sms",
      purpose: "marketing",
      method: String(form.get("method") ?? "verbal") as "verbal",
      proofText: String(form.get("proofText") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/customers");
  return { done: true };
}

export async function revokeMarketing(_previous: unknown, form: FormData) {
  try {
    await consent.revoke(await ctx(), {
      address: String(form.get("address") ?? ""),
      channel: "sms",
      purpose: "marketing",
      method: "verbal",
      proofText: String(form.get("proofText") ?? "") || null,
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/customers");
  return { done: true };
}

/**
 * Add somebody at this customer, or at one of their properties.
 *
 * `customerId` comes from the path rather than the form, so a contact cannot
 * be attached to a customer the caller was not looking at. `propertyId` does
 * come from the form, and the service checks both that it exists and that it
 * is one of this customer's addresses, the same check `POST
 * /v1/customers/{id}/contacts` gets, so the page's option list is a
 * convenience rather than the only guard.
 */
export async function addContact(_previous: unknown, form: FormData) {
  const customerId = String(form.get("customerId") ?? "");
  try {
    await contacts.create(await ctx(), {
      customerId,
      propertyId: String(form.get("propertyId") ?? "") || null,
      name: String(form.get("name") ?? ""),
      title: String(form.get("title") ?? "") || null,
      phone: String(form.get("phone") ?? "") || null,
      email: String(form.get("email") ?? "") || null,
      preferredChannel: String(form.get("preferredChannel") ?? "sms") as "sms",
    });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return refused(form, error.message);
    }
    throw error;
  }
  revalidatePath(`/customers/${customerId}`);
  return { done: true };
}

export async function removeContact(_previous: unknown, form: FormData) {
  const customerId = String(form.get("customerId") ?? "");
  try {
    await contacts.remove(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return refused(form, error.message);
    }
    throw error;
  }
  revalidatePath(`/customers/${customerId}`);
  return { done: true };
}

export async function makePrimary(_previous: unknown, form: FormData) {
  const customerId = String(form.get("customerId") ?? "");
  try {
    /**
     * Id and the one flag, nothing else. The service validates the MERGED
     * row, so every other field stays as it was. Sending the whole record
     * back from a button that means one thing is how a stale field
     * overwrites a fresh one.
     */
    await contacts.update(await ctx(), {
      id: String(form.get("id") ?? ""), isPrimary: true,
    });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return refused(form, error.message);
    }
    throw error;
  }
  revalidatePath(`/customers/${customerId}`);
  return { done: true };
}

/**
 * Take a customer off the books.
 *
 * Refused by the service when money points at them, and the refusal names
 * what. The screen asks `deletability` first so the button only appears when
 * it would work, but the guard stays in the service: a check on a page load
 * is stale by the time somebody clicks.
 */
export async function removeCustomer(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  try {
    await customerLifecycle.remove(await ctx(), {
      id, reason: String(form.get("reason") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/customers");
  redirect("/customers");
}

export async function mergeCustomer(_previous: unknown, form: FormData) {
  const keepId = String(form.get("keepId") ?? "");
  let result;
  try {
    result = await customerLifecycle.merge(await ctx(), {
      keepId, mergeId: String(form.get("mergeId") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return refused(form, error.message);
    }
    throw error;
  }
  revalidatePath(`/customers/${keepId}`);
  return {
    done: true,
    moved: result.moved.map((m) => `${m.n} ${m.label}`),
    filled: result.filled,
  };
}

/**
 * Text this customer, through the same send a reply uses.
 *
 * The customer id comes from the page and the service reads the customer
 * inside the caller's scope, so it cannot reach a customer they may not see.
 * A refusal (they replied STOP, no number to send from) comes back in words.
 */
export async function textCustomer(_previous: unknown, form: FormData) {
  const customerId = String(form.get("customerId") ?? "");
  let conversationId: string;
  try {
    ({ conversationId } = await comms.start(await ctx(), {
      customerId, body: String(form.get("body") ?? ""),
    }));
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) return refused(form, error.message);
    throw error;
  }
  redirect(`/inbox/${conversationId}`);
}

/**
 * THE CUSTOMER'S OWN LINK to their whole account: every invoice, estimate
 * and visit, without a login. `POST /v1/portal/grants` with the customer
 * scope, which was the only way to make one. The plaintext link exists once,
 * in this answer, and is shown to be handed on.
 */
export async function accountLink(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    const issued = await portal.issueGrant(await ctx(), parsed(issuePortalGrant.input, {
      customerId: String(form.get("customerId") ?? ""), scope: "customer",
    }));
    return { message: "Their account link. It opens everything they have with you, without a password.", link: issued.url };
  });
}

/**
 * Where a customer came from, corrected by the office. Checked against the
 * channel list by the service and recorded as a declared touch, so the
 * correction reaches the marketing report rather than only this page.
 */
export async function setCustomerSource(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = field(form, "customerId") ?? "";
  const picked = sourceFrom(form);
  const result = await attempt(form, async () => {
    await customers.update(await ctx(), {
      id: customerId,
      ...(picked.campaignId ? { campaignId: picked.campaignId }
        : picked.channelId ? { channelId: picked.channelId }
          : { leadSource: null, channelId: null, campaignId: null }),
    });
  });
  revalidatePath(`/customers/${customerId}`);
  return result;
}
