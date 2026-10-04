import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { adPlatforms } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * WHERE A PERSON COMES BACK FROM GOOGLE OR META
 *
 * The return address registered with the platform, exactly: the deployment's
 * `PUBLIC_URL` followed by this path. The platform sends the person here with
 * a code and the state they left with, or with an error when they pressed
 * Cancel. The service checks the state is one it issued, to this person, in
 * the last quarter of an hour, and not used before; trades the code for a
 * grant; seals it; and connects.
 *
 * It answers with a redirect back to the settings screen either way, carrying
 * the outcome in words, because the person is mid flow in a browser and a
 * JSON body or a bare 409 is a dead end. The code and the state are never put
 * in that redirect.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const base = (process.env["PUBLIC_URL"] || url.origin).replace(/\/+$/, "");
  const back = (query: Record<string, string>) =>
    Response.redirect(`${base}/settings/integrations?${new URLSearchParams(query).toString()}`, 303);

  if (!user) return Response.redirect(`${base}/login`, 303);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;
  if (state.length < 16) return back({ signInError: "The platform sent you back without the sign in it started with. Start again." });

  try {
    const done = await adPlatforms.finishSignIn({ actor: user.actor, db: getDb() }, {
      state, ...(code ? { code } : {}), ...(error ? { error } : {}),
    });
    return back({ signedIn: done.provider });
  } catch (failure) {
    const name = failure instanceof Error ? failure.name : "";
    if (name === "ConflictError" || name === "NotFoundError" || name === "PermissionError") {
      return back({ signInError: (failure as Error).message.slice(0, 400) });
    }
    throw failure;
  }
}
