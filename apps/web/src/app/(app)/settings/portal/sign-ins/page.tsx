import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { portalAccess } from "@opentradesos/api/services";
import { assertCan } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { Attempts } from "./Attempts";

export const dynamic = "force-dynamic";

/**
 * WHO ASKED FOR A SIGN IN CODE, AND WHAT BECAME OF IT
 *
 * The answer to the phone call that starts "the code never came": whether
 * one was sent, where, whether the sender took it, and whether the person
 * then typed it wrong. Newest first, for addresses on somebody's record;
 * strangers typing numbers nobody has are left out. A customer's own page
 * shows the same rows for them, with their sign ins and a way to end them.
 */
export default async function PortalSignInsPage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "portal:read");
  const { attempts } = await portalAccess.attempts({ actor: user.actor, db: getDb() }, { limit: 100 });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/settings/portal">Customer portal</Crumb>
      <PageHeader title="Sign ins" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Every code a customer asked for, newest first. &ldquo;Not sent&rdquo; says why the message
        could not go: usually an address that replied STOP, bounced, or a sender that is not
        connected. To sign somebody out, open the customer.
      </p>
      {attempts.length === 0 ? (
        <Empty title="Nobody has asked for a sign in code yet" />
      ) : (
        <Attempts attempts={attempts} timezone={user.organizationTimezone} />
      )}
    </div>
  );
}
