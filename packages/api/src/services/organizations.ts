import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";

/**
 * CREATING A COMPANY
 *
 * There are two ways a company comes into existence. Somebody signs up on the
 * form, or whoever runs the deployment creates it for them through the
 * operator API. Both used to be able to diverge, and the first version of the
 * second would have: the signup form lived in the web app as a server action,
 * and the operator API lives here, so the obvious move was a second copy of
 * "insert an organization, insert a membership". The first time the signup
 * path learned something (a validated timezone, a slug that survives a
 * collision) the other one would not have, and the companies made by an
 * operator would quietly be a different kind of company.
 *
 * So the rows are written here, once, and both callers bring their own
 * transaction. What differs between them stays with them: signup writes a
 * password and a session, the operator issues a first-password link.
 *
 * It is written to work under row level security as well as above it. The
 * signup form runs on the web app's own connection; the operator runs as
 * `platform_operator`, which the policies apply to. The ids are generated
 * here rather than by the database so the tenant context can name the row
 * before it exists, which is what lets a policy keyed on "the current
 * organization" admit the insert that creates it. `set_config(..., true)` is
 * transaction scoped, so none of this survives onto a pooled connection, and
 * that matters on a transaction pooler such as Supabase's, where the next
 * transaction on this connection may be somebody else's.
 */

/**
 * Whether this is a zone this runtime actually knows.
 *
 * `Intl.DateTimeFormat` throws a RangeError on an unrecognised zone, and the
 * places that read this column call it on every booking page. Storing an
 * unchecked string would move a crash from the form that created the company,
 * where it is one person's problem, to the customer facing booking page,
 * where it is every one of that company's customers.
 */
export function knownZone(zone: string | undefined | null): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "company";

/** Whether an error is Postgres refusing a duplicate on the named index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  // drizzle passes postgres.js errors through, sometimes wrapped one level.
  for (let e = error as { code?: string; constraint_name?: string; cause?: unknown } | undefined, i = 0;
    e && i < 3; e = e.cause as typeof e, i += 1) {
    if (e.code === "23505") return constraint ? e.constraint_name === constraint : true;
  }
  return false;
}

/**
 * A person, by address. Lower cased, because the unique index is on the
 * stored value and two rows for `Sam@` and `sam@` are two logins for one
 * inbox.
 */
export async function createUser(
  tx: Database,
  input: { email: string; name: string },
): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`select set_config('app.user_id', ${id}, true)`);
  await tx.insert(schema.user).values({ id, email: input.email.toLowerCase(), name: input.name });
  return id;
}

export interface NewOrganization {
  name: string;
  /** Ignored unless it is a zone this runtime knows. See `knownZone`. */
  timezone?: string | undefined;
  /** The operator's own identifier for this company, when there is one. */
  externalRef?: string | undefined;
  ownerUserId: string;
}

/**
 * The organization row and its owner's membership. Nothing else, so that
 * what a company starts with is the same however it was made.
 *
 * The slug is a URL, so it has to be unique, and a company called "Smith
 * Plumbing" is not going to be the only one. The insert is tried in a
 * savepoint and retried with a suffix on a collision rather than checked
 * first, because a check cannot see other tenants' rows under row level
 * security and is a race above it.
 */
export async function createOrganization(
  tx: Database,
  input: NewOrganization,
): Promise<{ organizationId: string; slug: string }> {
  const organizationId = randomUUID();
  await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);

  const base = slugify(input.name);
  let slug = base;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint.insert(schema.organization).values({
          id: organizationId,
          name: input.name,
          slug,
          legalName: input.name,
          ...(knownZone(input.timezone) ? { timezone: input.timezone } : {}),
          ...(input.externalRef ? { externalRef: input.externalRef } : {}),
        });
      });
      break;
    } catch (error) {
      if (!isUniqueViolation(error, "organization_slug_idx") || attempt >= 5) throw error;
      slug = `${base.slice(0, 44)}-${randomBytes(3).toString("hex").slice(0, 5)}`;
    }
  }

  // The person who creates the company owns it. Anything less means the
  // first thing a new user hits is a permission error on their own data.
  await tx.insert(schema.membership).values({
    organizationId, userId: input.ownerUserId, role: "owner",
  });

  return { organizationId, slug };
}
