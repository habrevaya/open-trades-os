import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString, PageRequest, pageOf, Timestamps } from "./common";

/**
 * ONLINE BOOKING
 *
 * The availability endpoint is public and unauthenticated, and it is the only
 * place in the product where what we say is directly a promise to someone who
 * has not yet become a customer. So it never returns a slot the company cannot
 * serve. Availability is derived from business hours, time off, existing
 * commitments and the per-window ceiling; it is never a list somebody typed in
 * and forgot to update.
 *
 * Offering a slot that is then reschedule-called costs more than showing
 * nothing that day.
 */

export const AvailableSlot = z.object({
  date: z.string().date(),
  arrivalWindowId: Uuid,
  /** As the customer should read it: "Thursday 8am to 12pm". */
  label: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  /** How many of this window are left. Shown as scarcity only when it is true. */
  remaining: z.number().int(),
});

export const BookableService = z.object({
  id: Uuid,
  publicName: z.string(),
  publicDescription: z.string().nullable(),
  /** Null means "we will quote on site", which converts better than a number
   *  the company will not honour. */
  displayPrice: MoneyString.nullable(),
  currency: z.string().length(3),
  depositAmount: MoneyString.nullable(),
  depositPercent: RateString.nullable(),
  minNoticeHours: z.number().int(),
  maxAdvanceDays: z.number().int(),
  intakeFields: z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "select", "boolean", "number", "photo"]),
    required: z.boolean(),
    options: z.array(z.string()).optional(),
  })),
});

export const listBookableServices = defineRoute({
  method: "get",
  path: "/v1/public/services",
  summary: "What this company lets the public book",
  module: "M05",
  permissions: [],
  authorization: "public",
  input: z.object({
    organizationSlug: z.string().min(1).max(100),
    /** Filters to what is actually served at this address. */
    postalCode: z.string().max(20).optional(),
  }),
  output: z.object({
    organizationName: z.string(),
    services: z.array(BookableService),
  }),
});

export const getAvailability = defineRoute({
  method: "get",
  path: "/v1/public/availability",
  summary: "Real openings for a bookable service",
  description:
    "Derived from business hours, time off, existing commitments and the per-window ceiling. Never a list that was typed in.",
  module: "M05",
  permissions: [],
  authorization: "public",
  input: z.object({
    organizationSlug: z.string().min(1).max(100),
    bookableServiceId: Uuid,
    from: z.string().date(),
    /** Capped server side at the service's own maxAdvanceDays. */
    days: z.number().int().min(1).max(90).default(14),
    postalCode: z.string().max(20).optional(),
  }),
  output: z.object({ slots: z.array(AvailableSlot) }),
});

export const BookingRequestStatus = z.enum([
  "pending", "confirmed", "declined", "cancelled", "expired",
]);

export const BookingRequest = z.object({
  id: Uuid,
  status: BookingRequestStatus,
  bookableServiceId: Uuid,
  customerId: Uuid.nullable(),
  propertyId: Uuid.nullable(),
  jobId: Uuid.nullable(),
  contactName: z.string(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  requestedDate: z.string().date(),
  arrivalWindowId: Uuid.nullable(),
  notes: z.string().nullable(),
  intakeAnswers: z.record(z.unknown()),
  sourceUrl: z.string().nullable(),
  referrer: z.string().nullable(),
  utm: z.record(z.string()),
  declineReason: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
}).merge(Timestamps);

/**
 * Booking from the website.
 *
 * Public and unauthenticated, so it is rate limited by address and by IP, and
 * the slot is re-checked inside the transaction that writes the request. A
 * slot that was free when the page rendered and is taken by the time the form
 * posts has to fail here rather than become an overbooking someone discovers
 * on the dispatch board.
 */
export const createBookingRequest = defineRoute({
  method: "post",
  path: "/v1/public/bookings",
  summary: "Book from the website",
  module: "M05",
  permissions: [],
  authorization: "public",
  idempotent: true,
  input: z.object({
    organizationSlug: z.string().min(1).max(100),
    bookableServiceId: Uuid,
    requestedDate: z.string().date(),
    arrivalWindowId: Uuid,
    contactName: z.string().min(1).max(200),
    contactEmail: z.string().email().max(320).optional(),
    contactPhone: z.string().max(40).optional(),
    addressLine1: z.string().min(1).max(200),
    addressLine2: z.string().max(200).optional(),
    city: z.string().min(1).max(100),
    state: z.string().min(2).max(50),
    postalCode: z.string().min(1).max(20),
    notes: z.string().max(2000).optional(),
    intakeAnswers: z.record(z.unknown()).default({}),
    sourceUrl: z.string().max(2000).optional(),
    referrer: z.string().max(2000).optional(),
    utm: z.record(z.string()).default({}),
    /**
     * The landing page query string, raw. Send this rather than only `utm`:
     * the click id an ads platform matches a conversion back to (`gclid`,
     * `msclkid`, `fbclid`) is not a utm_ key, so a widget sending only the
     * utm bag loses the one value that lets a booked job be reported to the
     * account that paid for it.
     */
    landingQuery: z.string().max(4000).optional(),
    /** The anonymous thread, so touches made before this form are joined to it. */
    visitorId: z.string().max(200).optional(),
  }).refine((v) => v.contactEmail !== undefined || v.contactPhone !== undefined, {
    message: "An email address or a phone number is required to confirm the booking",
  }),
  output: z.object({
    request: BookingRequest,
    /** Lets the requester track it without creating an account. */
    trackingUrl: z.string().url(),
    /** Set when the service collects money to hold the slot. */
    depositDue: MoneyString.nullable(),
    paymentUrl: z.string().url().nullable(),
  }),
});

export const listBookingRequests = defineRoute({
  method: "get",
  path: "/v1/bookings",
  summary: "The inbound queue",
  module: "M05",
  permissions: ["booking:read"],
  input: PageRequest.extend({
    status: z.array(BookingRequestStatus).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  output: pageOf(BookingRequest.extend({ serviceName: z.string() })),
});

/**
 * Confirming turns the request into a customer, a property and a job in one
 * transaction, matching an existing customer where the address and contact
 * line up rather than creating a duplicate.
 */
export const confirmBookingRequest = defineRoute({
  method: "post",
  path: "/v1/bookings/{id}/confirm",
  summary: "Confirm a booking",
  module: "M05",
  permissions: ["booking:decide", "job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** Set to attach to a known customer instead of matching or creating. */
    customerId: Uuid.optional(),
    jobTypeId: Uuid.optional(),
    assignedUserId: Uuid.optional(),
  }),
  output: z.object({
    request: BookingRequest,
    customerId: Uuid,
    propertyId: Uuid,
    jobId: Uuid,
  }),
});

/**
 * Declining is a real outcome worth counting. The decline rate on a booking
 * widget is one of the few honest signals a company gets about whether the
 * availability it is advertising is availability it actually has.
 */
export const declineBookingRequest = defineRoute({
  method: "post",
  path: "/v1/bookings/{id}/decline",
  summary: "Decline a booking",
  module: "M05",
  permissions: ["booking:decide"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: z.enum([
      "outside_service_area", "no_capacity", "not_a_service_we_offer",
      "duplicate", "unreachable", "other",
    ]),
    note: z.string().max(1000).optional(),
    notifyCustomer: z.boolean().default(true),
  }),
  output: BookingRequest,
});

export const configureBookableService = defineRoute({
  method: "put",
  path: "/v1/booking/services/{id}",
  summary: "Choose what the public may book, and on what terms",
  module: "M05",
  permissions: ["booking:configure"],
  input: z.object({
    id: Uuid,
    publicName: z.string().min(1).max(200),
    publicDescription: z.string().max(2000).optional(),
    displayPrice: MoneyString.optional(),
    depositAmount: MoneyString.optional(),
    depositPercent: RateString.optional(),
    minNoticeHours: z.number().int().min(0).max(720),
    maxAdvanceDays: z.number().int().min(1).max(365),
    maxPerWindow: z.number().int().min(1).max(100),
    isActive: z.boolean(),
  }),
  output: BookableService,
});

/**
 * CREATING one, which nothing could do.
 *
 * `configureBookableService` UPDATES a row, and no code path in this product
 * ever inserted one: not the API, not the app, not the seed. So the public
 * booking page at /book/[slug] rendered an empty service list for every
 * company, permanently, and the one endpoint that touched the table updated
 * rows that could not exist. A whole customer-facing module was unreachable
 * and nothing said so.
 */
export const createBookableService = defineRoute({
  method: "post",
  path: "/v1/booking/services",
  summary: "Offer a job type to the public",
  description:
    "Per job type rather than per company: a shop will let the internet book a tune up two days out and will never let it book an emergency line replacement, and the difference is the job type.",
  module: "M05",
  permissions: ["booking:configure"],
  idempotent: true,
  input: z.object({
    jobTypeId: Uuid,
    publicName: z.string().min(1).max(200),
    publicDescription: z.string().max(2000).optional(),
    /**
     * Absent means "we will quote on site", which is honest and converts
     * better than a number the company will not honour.
     */
    displayPrice: MoneyString.optional(),
    depositAmount: MoneyString.optional(),
    depositPercent: RateString.optional(),
    minNoticeHours: z.number().int().min(0).max(720).default(24),
    maxAdvanceDays: z.number().int().min(1).max(365).default(60),
    maxPerWindow: z.number().int().min(1).max(100).default(2),
  }),
  output: BookableService,
});

/**
 * The arrival windows the booking page offers, and the days the company is
 * open. Both tables were written by nothing, which is the other half of why
 * the booking page had nothing on it: with no windows and no hours, even a
 * service would have produced an empty calendar.
 */
export const setArrivalWindows = defineRoute({
  method: "put",
  path: "/v1/booking/arrival-windows",
  summary: "Set the arrival windows customers may choose",
  description:
    "Sent as the whole list rather than one at a time, so there is no moment where a company has half a set of windows published.",
  module: "M05",
  permissions: ["booking:configure"],
  input: z.object({
    windows: z.array(z.object({
      name: z.string().min(1).max(60),
      /** Wall clock in the company's zone. "08:00", not an instant. */
      startsAt: z.string().regex(/^\d{2}:\d{2}$/),
      endsAt: z.string().regex(/^\d{2}:\d{2}$/),
      /** 0 is Sunday, matching Postgres `dow` and JS `getDay`. */
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
    })).max(20),
  }),
  output: z.object({ windows: z.number().int() }),
});

export const setBusinessHours = defineRoute({
  method: "put",
  path: "/v1/booking/hours",
  summary: "Set which days the company is open",
  module: "M05",
  permissions: ["booking:configure"],
  input: z.object({
    days: z.array(z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      opensAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
      closesAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
      closed: z.boolean(),
    })).length(7),
  }),
  output: z.object({ days: z.number().int() }),
});

export const bookingRoutes = {
  createBookableService, setArrivalWindows, setBusinessHours,
  listBookableServices, getAvailability, createBookingRequest,
  listBookingRequests, confirmBookingRequest, declineBookingRequest,
  configureBookableService,
} as const;
