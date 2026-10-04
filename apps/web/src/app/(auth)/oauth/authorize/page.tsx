import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { oauth } from "@opentradesos/api/services";
import { can, permissionsFor } from "@opentradesos/core";
import { answer } from "./actions";

export const dynamic = "force-dynamic";

/**
 * CONNECTING AN AI ASSISTANT, IN PLAIN WORDS
 *
 * A remote MCP client (an assistant somebody uses on the web or on their
 * desktop) sends the person here to ask for access to their company. The page
 * says who is asking, where the answer goes, and what it would be able to do,
 * every permission in the catalogue's own words, with the ones that expose
 * money marked and the ones the person cannot give named as left out. The
 * answer is yes to that list or no.
 *
 * A yes makes the assistant a connected app of this company, listed under
 * Settings, Applications beside every other, with its own credential that
 * lasts an hour and is renewed, and that the owner can turn off there.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireSetupUser();
  const params = await searchParams;
  const check = await oauth.checkAuthorization(getDb(), params);

  if (check.kind === "bounce") redirect(check.to);
  if (check.kind === "stop") {
    return (
      <>
        <h1 className="text-xl font-semibold">This connection cannot go ahead</h1>
        <p role="alert" className="mt-3 text-sm text-red-600">{check.message}</p>
        <p className="mt-3 text-sm text-ink-700">
          Nothing was sent anywhere. Close this page and connect again from the assistant.
        </p>
      </>
    );
  }

  const held = permissionsFor(user.actor);
  const consent = oauth.consentFor(check.scopes, held);
  const allowed = can(user.actor, "integration:write");
  const returnsTo = new URL(check.redirectUri).host || check.redirectUri;
  const hidden = Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string");

  return (
    <>
      <h1 className="text-xl font-semibold">Connect {check.client.name}?</h1>
      <p className="mt-2 text-sm text-ink-700">
        It is asking to work in <strong>{user.organizationName}</strong> as an application you approve.
        The answer goes back to <span className="font-mono">{returnsTo}</span>.
      </p>

      {consent.bundles.length > 0 ? (
        <ul className="mt-4 list-disc pl-5 text-sm text-ink-900">
          {consent.bundles.map((bundle) => <li key={bundle.name}>{bundle.label}</li>)}
        </ul>
      ) : null}

      <h2 className="mt-5 text-sm font-medium text-ink-700">What it would be able to do</h2>
      {consent.granted.length === 0 ? (
        <p className="mt-1 text-sm text-red-600">You hold none of what it asks for, so there is nothing you can give it.</p>
      ) : (
        <ul className="mt-1.5 space-y-1 text-sm" aria-label="What it would be able to do">
          {consent.granted.map((item) => (
            <li key={item.permission}>
              {item.label}
              {item.sensitive ? <span className="ml-1.5 text-xs font-medium text-amber-700">shows money</span> : null}
            </li>
          ))}
        </ul>
      )}
      {consent.withheld.length > 0 ? (
        <>
          <h2 className="mt-4 text-sm font-medium text-ink-700">Left out, because you do not hold it yourself</h2>
          <ul className="mt-1.5 space-y-1 text-sm text-ink-500">
            {consent.withheld.map((item) => <li key={item.permission}>{item.label}</li>)}
          </ul>
        </>
      ) : null}
      <p className="mt-4 text-sm text-ink-500">
        It reaches the same records you can, and never more. You can turn it off at any time under
        Settings, Applications, and it stops on its next call.
      </p>

      {allowed ? null : (
        <p role="alert" className="mt-4 text-sm text-red-600">
          Connecting an application needs the permission that connects integrations. Ask an owner.
        </p>
      )}

      <form action={answer} className="mt-6 flex gap-3">
        {hidden.map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        {allowed && consent.granted.length > 0 ? (
          <button type="submit" name="decision" value="approve"
                  className="inline-flex h-10 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-700">
            Connect
          </button>
        ) : null}
        <button type="submit" name="decision" value="refuse"
                className="inline-flex h-10 items-center rounded border border-steel-300 px-4 text-sm font-medium hover:bg-steel-100">
          Do not connect
        </button>
      </form>
    </>
  );
}
