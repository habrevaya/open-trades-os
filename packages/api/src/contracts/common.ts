import { z } from "zod";

/**
 * Shared shapes. Defined once so pagination, money and addresses behave
 * identically on every endpoint, which is the difference between an API
 * somebody can learn and one they have to keep looking up.
 */

export const Uuid = z.string().uuid();

/**
 * Money on the wire is a decimal STRING, never a JSON number.
 *
 * JSON numbers are IEEE 754 doubles. Serializing 0.1 and parsing it back does
 * not give you 0.1, and a client in another language will silently do
 * something different again. The string is unambiguous in every language and
 * survives a round trip exactly.
 */
export const MoneyString = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "Money must be a decimal string with at most 4 places");

export const RateString = z.string().regex(/^-?\d+(\.\d{1,6})?$/, "Rate must be a decimal string with at most 6 places");

export const Address = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(50),
  postalCode: z.string().min(1).max(20),
  country: z.string().length(2).default("US"),
});

/**
 * Cursor pagination, not offset. Offset pagination silently skips or repeats
 * rows when the underlying set changes between pages, which during a migration
 * or a busy dispatch morning is most of the time.
 */
export const PageRequest = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });

export const SortOrder = z.enum(["asc", "desc"]).default("desc");

/** Errors are a stable shape so a client can branch on them. */
export const ApiError = z.object({
  error: z.object({
    code: z.enum([
      "unauthenticated", "forbidden", "not_found", "conflict",
      "validation_failed", "rate_limited", "idempotency_conflict",
      "authorization_exceeded", "period_closed", "internal",
    ]),
    message: z.string(),
    /** Field path to message, for form display. */
    fields: z.record(z.string()).optional(),
    /** The permission that was missing, when the code is forbidden. */
    permission: z.string().optional(),
  }),
});

export const Timestamps = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
