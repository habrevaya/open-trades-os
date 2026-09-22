import { dispatch } from "@opentradesos/api/http";
import { getDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * THE HTTP API
 *
 * Every route in the contracts, served by one catch-all, because the contract
 * already declares the method, the path, the input schema and who may call
 * it. A file per endpoint would be sixty files restating what the contract
 * knows, and the first one to fall out of step would be a security hole
 * rather than a typo.
 *
 * The dispatcher itself lives in @opentradesos/api and takes a Request and
 * returns a Response, with no Next.js in it. Self hosting is the point of
 * this product, and an API that only runs inside one framework is a smaller
 * promise than it sounds.
 *
 * Session resolution is passed in rather than imported by the dispatcher,
 * because reading a cookie is the host framework's job and the API package
 * must not depend on the app that mounts it.
 */
async function handle(request: Request): Promise<Response> {
  return dispatch(request, {
    db: getDb(),
    // The contracts declare `/v1/...`; Next.js route handlers live under
    // `/api`. Without this every request is a 404 that reads like a missing
    // route rather than a mounting mistake.
    basePath: "/api",
    resolveSession: async () => {
      const user = await getCurrentUser();
      if (!user) return null;
      /**
       * A tenant-scoped context, never a bare database handle. Everything
       * below this line goes through the service layer's permission check and
       * the row level security that the actor's organization sets, which is
       * exactly what makes this endpoint safe to expose.
       */
      return { actor: user.actor, db: getDb() };
    },
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
