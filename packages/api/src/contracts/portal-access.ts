import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";
import { AvailableSlot } from "./booking";

/**
 * WHO SIGNS IN TO A CUSTOMER'S ACCOUNT, THE COMPANY'S LOOK BEFORE THEY DO,
 * WHAT THEY SEE OF THE WORK, AND BOOKING FROM THE ACCOUNT
 *
 * The office side of customer sign in (the attempts, the sign ins, ending
 * one, and which contacts may sign in as the customer), the public brand a
 * sign in page shows, sharing a visit's notes with the customer, the bank
 * payments on their way, and a signed in customer asking for a visit with
 * the technician they had last time.
 */

const Token = z.string().min(20).max(200);

export const SignInAttempt = z.object({
  id: Uuid,
  at: z.string().datetime(),
  channel: z.enum(["email", "sms"]),
  address: z.string(),
  /** What became of it: signed in, still waiting, wrong code typed, killed by five wrong codes, replaced by a newer one, ran out, or an address nobody has. */
  outcome: z.enum(["signed_in", "waiting", "wrong_code", "too_many_attempts", "replaced", "expired", "no_account"]),
  wrongCodes: z.number().int(),
  /** `queued`, or why the message could not go. */
  delivery: z.string().nullable(),
  requestedIp: z.string().nullable(),
  signedInIp: z.string().nullable(),
  customers: z.array(z.object({ id: Uuid, name: z.string() })),
  contactName: z.string().nullable(),
});

export const listPortalSignIns = defineRoute({
  method: "get",
  path: "/v1/portal-sign-ins",
  summary: "Customers asking for sign in codes, and what became of each",
  description:
    "Newest first. With a customer, the codes that signed in as them and the ones asked for at an address on their record at the time, so a failed try shows on the customer it was aimed at. Without one, every attempt at an address somebody has; strangers typing numbers nobody has are left out. What became of the message is here too, which answers \"the code never came\".",
  module: "M05",
  permissions: ["portal:read"],
  input: z.object({
    customerId: Uuid.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ attempts: z.array(SignInAttempt) }),
});

export const PortalSignInSession = z.object({
  id: Uuid,
  startedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  lastUsedIp: z.string().nullable(),
  active: z.boolean(),
  endedAt: z.string().datetime().nullable(),
  /** `signed_out` by the customer, `office`, or `access_removed` when a contact's access was taken away. */
  endedReason: z.string().nullable(),
  channel: z.enum(["email", "sms"]).nullable(),
  address: z.string().nullable(),
  /** The contact who signed in as the customer, when it was not the customer. */
  contactName: z.string().nullable(),
});

export const listCustomerPortalSessions = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/portal-sessions",
  summary: "A customer's sign ins, open and recently ended",
  module: "M05",
  permissions: ["portal:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ sessions: z.array(PortalSignInSession) }),
});

export const endCustomerPortalSessions = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/portal-sessions/end",
  summary: "End a customer's sign in, or every one they have open",
  description:
    "Ended everywhere at once, the way their own sign out ends it: the next page they open asks for a code. Links the office sent them are left alone. Ending one that has already ended changes nothing.",
  module: "M05",
  permissions: ["portal:revoke"],
  idempotent: true,
  input: z.object({ id: Uuid, sessionId: Uuid.optional() }),
  output: z.object({ ended: z.number().int() }),
});

export const setContactPortalAccess = defineRoute({
  method: "post",
  path: "/v1/contacts/{id}/portal-access",
  summary: "Let a contact sign in as their customer, or stop them",
  description:
    "A contact the office allows signs in with their own email or mobile number and sees the customer's account; what they do there is recorded as them. Only a contact on a customer, with an address a code can go to. Taking it away ends every sign in they have open.",
  module: "M05",
  permissions: ["customer:write", "portal:revoke"],
  idempotent: true,
  input: z.object({ id: Uuid, allowed: z.boolean() }),
  output: z.object({ id: Uuid, portalAccess: z.boolean(), endedSessions: z.number().int() }),
});

export const getPublicPortalBranding = defineRoute({
  method: "get",
  path: "/v1/public/portal/{organizationSlug}/branding",
  summary: "A company's name, colour and whether it has a logo, for its sign in page",
  description:
    "The sign in page has no token to brand itself from, so it is branded from the company's public key. Only what goes on the van: the name, the colour (with the colours readable on it) and whether there is a logo. The logo itself is served at `/portal/{slug}/logo`.",
  module: "M05",
  permissions: [],
  authorization: "public",
  input: z.object({ organizationSlug: z.string().min(1).max(100) }),
  output: z.object({
    organizationName: z.string(),
    color: z.string().nullable(),
    on: z.string().nullable(),
    text: z.string().nullable(),
    hasLogo: z.boolean(),
    version: z.number().int(),
  }),
});

export const shareVisitNotes = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/customer-notes",
  summary: "Show the customer what happened on a visit, in words the office chose",
  description:
    "The technician's own notes are never shown as they stand. This shares a copy, the notes as they read now or the office's wording of them, on the customer's account beside the visit; null stops showing it. The same permission as publishing a service report.",
  module: "M05",
  permissions: ["servicereport:publish"],
  idempotent: true,
  input: z.object({ id: Uuid, notes: z.string().max(4000).nullable() }),
  output: z.object({ id: Uuid, customerNotes: z.string().nullable(), sharedAt: z.string().datetime().nullable() }),
});

export const BankPayment = z.object({
  id: Uuid,
  /** On its way, or failed: a bank payment that arrived is an ordinary payment. */
  status: z.enum(["pending", "failed"]),
  amount: MoneyString,
  invoiceIds: z.array(Uuid),
  startedAt: z.string().datetime(),
  failedAt: z.string().datetime().nullable(),
  reason: z.string().nullable(),
});

export const listBankPayments = defineRoute({
  method: "get",
  path: "/v1/bank-payments",
  summary: "Bank payments on their way, and the ones that failed this month",
  description:
    "A bank payment is pending for a few business days before the processor says whether it arrived, and the invoice stays open meanwhile; it cannot be paid again until then. A failed one raised a task in the office queue saying why.",
  module: "M13",
  permissions: ["payment:read"],
  input: z.object({ customerId: Uuid.optional(), invoiceId: Uuid.optional() }),
  output: z.object({ bankPayments: z.array(BankPayment) }),
});

export const getPortalBookingOptions = defineRoute({
  method: "get",
  path: "/v1/portal/booking",
  summary: "What a signed in customer can book, where, and with whom",
  description:
    "From a sign in only. The services the company takes online, the customer's own addresses, and the technicians who have been to them before, by first name: the ones they can ask for again.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: Token }),
  output: z.object({
    services: z.array(z.object({
      id: Uuid, name: z.string(), description: z.string().nullable(), price: MoneyString.nullable(), currency: z.string(),
    })),
    properties: z.array(z.object({ id: Uuid, label: z.string() })),
    technicians: z.array(z.object({ id: Uuid, name: z.string() })),
  }),
});

export const getPortalBookingAvailability = defineRoute({
  method: "get",
  path: "/v1/portal/booking/availability",
  summary: "The windows open for a service, from anybody or from one technician",
  description:
    "From a sign in only. The same windows the public widget offers, from the same function; with a technician, only that person's own free time, and only a technician who has been to this customer before. A member whose plan promises priority is also offered the share of each window the company holds for members, at the address named or, with none named, at any of theirs.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({
    token: Token,
    bookableServiceId: Uuid,
    from: z.string().date().optional(),
    days: z.number().int().min(1).max(60).default(14),
    technicianId: Uuid.optional(),
    /** The address the visit is for, which decides whether a member's plan covers it. */
    propertyId: Uuid.optional(),
  }),
  output: z.object({ slots: z.array(AvailableSlot) }),
});

export const requestPortalBooking = defineRoute({
  method: "post",
  path: "/v1/portal/booking",
  summary: "Ask for a visit from the customer's own account",
  description:
    "From a sign in only. Writes a booking request already carrying the customer and the property, checked against the window and the technician's day inside the same transaction. The office books it; booking it with its visit puts the technician asked for on it when they are still free and qualified.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: Token,
    bookableServiceId: Uuid,
    propertyId: Uuid,
    requestedDate: z.string().date(),
    arrivalWindowId: Uuid,
    technicianId: Uuid.optional(),
    notes: z.string().max(2000).optional(),
  }),
  output: z.object({ requestId: Uuid, requestedDate: z.string().date(), arrivalWindowId: Uuid }),
});

export const portalAccessRoutes = {
  listPortalSignIns, listCustomerPortalSessions, endCustomerPortalSessions, setContactPortalAccess,
  getPublicPortalBranding, shareVisitNotes, listBankPayments,
  getPortalBookingOptions, getPortalBookingAvailability, requestPortalBooking,
} as const;
