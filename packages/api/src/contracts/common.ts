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

/**
 * Source systems this product writes provenance for itself. A caller may not
 * claim one: a job tagged `recurring_schedule` by an integration would look,
 * to the recurring engine, like an occurrence it had already generated, and
 * the real one would never be booked.
 */
export const RESERVED_SOURCES = ["recurring_schedule"] as const;

/**
 * WHERE A RECORD CAME FROM, WHEN IT CAME FROM ANOTHER SYSTEM.
 *
 * `source` names the system, in lower case: `jobber`, `housecall_pro`,
 * `servicetitan`. `id` is that system's own id for the record, exactly as it
 * gave it. The pair is unique per company per kind of record, so a migration
 * that is run twice finds what it already loaded rather than loading it again,
 * and "which invoice did Jobber invoice 2201 become" has one answer, forever.
 *
 * Set on create and never changed: provenance that can be edited is not
 * provenance.
 */
export const ExternalRef = z.object({
  source: z.string()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,49}$/, "A source is a lower case name, like jobber or housecall_pro")
    .refine((v) => !(RESERVED_SOURCES as readonly string[]).includes(v), "That source is written by this product itself"),
  id: z.string().min(1).max(200),
});

/**
 * Finding a record by where it came from. Both together name one record;
 * `externalSource` alone lists everything that came from that system.
 */
export const ExternalLookup = {
  externalSource: z.string().max(50).optional(),
  externalId: z.string().max(200).optional(),
};

/**
 * How a customer reaches a company, as its documents print it. Every field
 * may be null, and a document prints only the ones that are set.
 */
export const CompanyContact = z.object({
  phone: z.string().nullable().describe("E.164."),
  email: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
});
