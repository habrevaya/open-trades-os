import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayIn } from "@/lib/dates";
import { dispatch, fieldOps, safety } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Day } from "./Day";
import { SafetyTalks } from "./SafetyTalks";
import { OfflineReady } from "./OfflineReady";
import { CACHE_FILL_HEADER } from "@/lib/my-day-offline";

export const dynamic = "force-dynamic";

/**
 * THE TECHNICIAN'S DAY, ON A PHONE
 *
 * A web view rather than a native app, first, and deliberately.
 *
 * This product is self hosted. A native app means the operator builds it,
 * signs it, and gets it through two app stores before a single technician can
 * use it, which for a two-truck plumbing company is a reason not to adopt the
 * software at all. A page works on the phone they already have, the moment the
 * server is up.
 *
 * The native app is still worth building: it gets background sync, reliable
 * camera capture and a home screen icon. But it is the second thing, not the
 * first, and a company should be able to run a day without it.
 */
export default async function MyDayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireSetupUser();

  /**
   * The guard is "does this account have a technician record", not "does it
   * hold field:sync".
   *
   * An owner holds every permission, including field:sync, so a permission
   * check let the owner through and then the page threw five hundred from
   * inside device registration. The permission answers whether the account is
   * ALLOWED to sync; only the technician record answers whether there is a
   * person with a route, and that is the question this screen is asking.
   *
   * It is not the same as "owners cannot use this page". In a two truck shop
   * the owner runs calls too. Give them a technician record and this screen is
   * theirs, which is the correct behaviour and the one a permission check
   * could not express.
   */
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "field:sync") || !(await fieldOps.isTechnician(ctx))) {
    // No route to show. The board is the screen they want.
    redirect("/schedule");
  }

  const params = await searchParams;
  const date = params.date ?? todayIn(user.organizationTimezone);

  /**
   * Registered here rather than on a settings screen. A technician opening
   * their day on a borrowed phone should not have to do anything first, and
   * the registration is keyed on a stable installation id so it is a lookup
   * rather than a new device every morning.
   */
  /**
   * The page fetching itself to keep a copy for no signal (`OfflineReady`)
   * only looks the device up. Registering also lifts a revocation, and a fetch
   * the person never made must not undo the office taking this browser away.
   */
  const installationId = `web:${user.userId}`;
  const fillingCache = (await headers()).get(CACHE_FILL_HEADER) === "1";
  const device = (fillingCache ? await fieldOps.registered(ctx, installationId) : null)
    ?? await fieldOps.register(ctx, { installationId, label: "Browser" });

  const snapshot = await dispatch.snapshot(ctx, {
    deviceId: device.deviceId,
    from: date,
    days: 1,
  });

  /**
   * The toolbox talks waiting for this technician's signature, above the
   * route, and a way to report something that went wrong. Both are their own
   * business: the register is somebody else's screen.
   */
  const talks = await safety.mine(ctx);

  return (
    <>
    <div className="mx-4 mt-2"><OfflineReady person={user.userId} /></div>
    <SafetyTalks talks={talks} timezone={user.organizationTimezone} />
    {can(user.actor, "safety:report") ? (
      <p className="mx-4 mt-3 text-sm">
        <a href="/compliance/incidents/new" className="text-blue-600 underline underline-offset-4">
          Report an incident or a near miss
        </a>
      </p>
    ) : null}
    <Day
      date={date}
      deviceId={device.deviceId}
      lastSequence={device.lastSequence}
      visits={snapshot.visits}
      openTimeEntry={snapshot.openTimeEntry}
      technicianName={user.name ?? user.email}
      timezone={user.organizationTimezone}
      inspectionPrograms={snapshot.inspectionPrograms}
      priceBook={snapshot.priceBook}
      abilities={snapshot.abilities}
      tasks={snapshot.tasks}
      expenses={snapshot.expenses}
      today={todayIn(user.organizationTimezone)}
    />
    </>
  );
}
