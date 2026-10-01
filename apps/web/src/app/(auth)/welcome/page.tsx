import type { Metadata } from "next";
import { setupTokens } from "@opentradesos/api/services";
import { getDb } from "@/lib/db";
import { WelcomeForm } from "./WelcomeForm";

export const dynamic = "force-dynamic";

/**
 * No referrer, so the token in this page's address is not handed to anything
 * the page links to or loads. It is single use and short lived either way;
 * this is the difference between it being in one log and in several.
 */
export const metadata: Metadata = { referrer: "no-referrer", title: "Set your password" };

/**
 * WHERE A COMPANY SOMEBODY ELSE CREATED IS HANDED OVER
 *
 * The operator API creates a company and its owner and returns a link to
 * this page. The owner chooses a password here, once, and is signed in.
 *
 * The link is checked before the form is shown, so somebody holding a spent
 * or replaced link is told so before typing a password, rather than after.
 * Checking it here spends nothing: the form's own submission is what spends
 * it, atomically with storing the password.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;
  const target = await setupTokens.peek(getDb(), token);

  if (!target) {
    return (
      <>
        <h1 className="text-xl font-semibold">This link is no longer valid</h1>
        <p className="mt-3 text-sm text-ink-700">
          It may have been used already, replaced by a newer one, or expired. If you
          have set your password, <a href="/login" className="text-blue-600 hover:underline">sign
          in</a>. If not, ask whoever set up your account to send a new link.
        </p>
      </>
    );
  }

  return <WelcomeForm token={token} email={target.email} name={target.name} />;
}
