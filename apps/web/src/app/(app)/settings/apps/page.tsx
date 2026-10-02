import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { apps as appService } from "@opentradesos/api/services";
import {
  can, PERMISSIONS, SENSITIVE_PERMISSIONS, SCOPED_RESOURCES, SCOPES, permissionsFor,
} from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { Apps } from "./AppsView";
import { InstallApp, IssueToken, RevokeToken, RevokeApp } from "./ActionForm";

export const dynamic = "force-dynamic";

/**
 * THE APPLICATIONS THIS COMPANY HAS LET IN
 *
 * `services/apps.ts` could install an app, change what it may do, revoke it,
 * issue it a credential and revoke one, all guarded and all tested, and there was
 * no route and no screen for any of it. So the module BUILD.md and
 * `docs/concepts/connected-apps.md` both describe as the way a third party
 * integrates with this product was unreachable: an owner could not approve an
 * app, could not see which ones held a credential, and could not revoke one.
 *
 * WHAT THIS SCREEN IS FOR IS THE REVOCATION AND THE GRANT, in that order. "Which
 * integration is reading my customer list" is the question an operator asks, and
 * the answer has to be on a screen rather than in a table, because the moment
 * they ask it they are usually in a hurry.
 *
 * THE PERMISSION LIST OFFERED IS THE INSTALLER'S OWN. The service refuses a grant
 * wider than what the caller holds, and a form offering the whole catalogue to
 * somebody who holds half of it is a form whose refusals are a surprise. Offering
 * only theirs makes the rule visible before they press anything, and the service
 * still refuses, because a screen is not where that decision is made.
 */
export default async function AppsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Applications" />
        <Empty title="Settings are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const list = await appService.list(ctx);
  const writes = can(user.actor, "integration:write");

  const sensitive = new Set<string>(SENSITIVE_PERMISSIONS);
  const held = [...permissionsFor(user.actor)].sort();
  const offered = held.map((permission) => ({
    value: permission,
    label: PERMISSIONS[permission],
    sensitive: sensitive.has(permission),
  }));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Applications" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        An application acts against this company with a grant you approved. It gets the same kind of
        authority a person does, so every permission check and record scope applies to it unchanged,
        and it cannot be given anything you do not hold yourself. Revoking one takes effect on its
        next call.
      </p>

      <Apps
        apps={list}
        {...(writes
          ? {
              control: (app) => (app.status === "revoked"
                ? null
                : <RevokeApp id={app.id} name={app.name} />),
              tokenControl: (app, token) => (token.revokedAt !== null
                ? null
                : <RevokeToken tokenId={token.id} label={token.label ?? app.name} />),
            }
          : {})}
      />

      {writes
        ? (
          <>
            {list.filter((app) => app.status !== "revoked").map((app) => (
              <section key={app.id} className="mt-6">
                <h2 className="text-sm font-medium text-ink-700">
                  A new credential for {app.name}
                </h2>
                <p className="mt-1 max-w-2xl text-sm text-ink-500">
                  Shown once and never again, because only its hash is kept. Issuing another is also
                  what you do if one leaks: issue, put it in place, then revoke the old one.
                </p>
                <IssueToken appId={app.id} name={app.name} />
              </section>
            ))}

            <h2 className="mt-10 text-sm font-medium text-ink-700">Let an application in</h2>
            <InstallApp
              permissions={offered}
              resources={[...SCOPED_RESOURCES]}
              scopes={[...SCOPES]}
            />
          </>
        )
        : (
          <p className="mt-6 text-sm text-ink-500">
            Approving an application or revoking one needs the permission that connects
            integrations, not the one that reads settings.
          </p>
        )}
    </div>
  );
}
