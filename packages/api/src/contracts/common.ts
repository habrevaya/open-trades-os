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

/**
 * Errors are a stable shape so a client can branch on them.
 *
 * THIS IS WHAT THE DISPATCHER ACTUALLY WRITES, and it did not used to be.
 * The shape declared here was `{ error: { code, message, fields, permission } }`
 * with a machine-readable `code` an SDK could switch on. Nothing in the
 * codebase ever emitted it: `problem()` in src/http/dispatch.ts writes
 * `{ error: "<a sentence>", status: <number> }` and always has. Any client
 * that trusted this file and branched on `error.code` was branching on
 * undefined, forever, for every error the API can return.
 *
 * It is corrected to the truth rather than the other way round, deliberately.
 * Changing the dispatcher to match would have been a breaking change to every
 * error every existing caller already handles, made in order to honour a
 * promise nobody had been able to rely on. The machine-readable code is worth
 * having and is a separate, additive piece of work: a `code` field alongside
 * the existing two, with the prose kept.
 *
 * `status` is the HTTP status repeated in the body. It is genuinely useful to
 * a client reading a response it has already parsed, and it is what the
 * dispatcher sends.
 */
export const ApiError = z.object({
  /** A sentence for a person. Not a code, and not stable enough to match on. */
  error: z.string(),
  status: z.number().int(),
  /**
   * On a 422 only: which field failed and why, so an integrator can fix a
   * request from "limit: expected number, received string".
   */
  issues: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })).optional(),
  /** On a 405 only: the methods this path does serve. */
  allowed: z.array(z.string()).optional(),
});

export const Timestamps = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
