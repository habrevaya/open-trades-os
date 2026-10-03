"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { signIn, type ActionState } from "./actions";

/**
 * "Sign in with Google", or with Meta.
 *
 * The person leaves for the platform's own consent screen and comes back to
 * `/settings/integrations/oauth`. Shown once the settings are saved, because
 * the sign in needs the name of the OAuth client to know which consent screen
 * to send them to; shown again on a connected platform, because signing in
 * again is how a revoked or expired grant is replaced.
 */
export function SignIn({
  provider, platform, status, mayChange,
}: {
  provider: string;
  platform: "Google" | "Meta";
  status: string;
  mayChange: boolean;
}) {
  const [state, form, pending] = useKeptAction<ActionState>(signIn, {});
  const words = status === "connected"
    ? `Signed in. Sign in with ${platform} again only to replace the access it holds.`
    : status === "needs_reauth"
      ? `${platform} stopped accepting the sign in, so nothing is pulled or sent until somebody signs in again.`
      : `Saved. Nothing is pulled or sent until somebody who manages the account signs in with ${platform}.`;
  return (
    <div className="mt-3 rounded border border-steel-200 p-3">
      <p className="text-sm text-ink-700">{words}</p>
      {mayChange && (
        <form {...form} className="mt-2">
          <input type="hidden" name="provider" value={provider} />
          <button
            type="submit"
            disabled={pending}
            className={status === "connected"
              ? "h-9 rounded border border-steel-300 px-3 text-sm font-medium"
              : "h-9 rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-40"}
          >
            {pending ? "Sending you to " + platform : `Sign in with ${platform}`}
          </button>
          {state.error && <p className="mt-2 text-sm text-red-600" role="alert">{state.error}</p>}
        </form>
      )}
    </div>
  );
}
