import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fieldDevices } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { Mobile, Revoke } from "./Forms";

export const dynamic = "force-dynamic";

/**
 * THE PHONES
 *
 * Every technician, the number their sign in code is texted to, and every
 * phone they have signed in on: when it was last heard from, whether it is
 * signed in, and whether changes to their day reach it. A lost phone is taken
 * away here, which ends its sign in on every route at once and stops its
 * notices; the API had this and nobody could reach it without writing a call.
 *
 * `user:read` to look and `user:write` to change anything, the same as
 * deciding what somebody may do, because taking a person's phone away is the
 * same kind of decision.
 */
export default async function PhonesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "user:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Phones" />
        <Empty title="The team's phones are not part of your access">
          Somebody who can manage people can turn this on for you.
        </Empty>
      </div>
    );
  }

  const writes = can(user.actor, "user:write");
  const { technicians } = await fieldDevices.people(ctx, {});
  const when = (iso: string | null) => iso
    ? new Date(iso).toLocaleString("en-US", {
        timeZone: user.organizationTimezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : "Never";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Phones" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The phones each technician has signed in on with the field app or a browser. Taking a phone away
        signs it out everywhere at once and stops it being told about changes to their day. It does not
        stop the person signing in again; to do that, take them off the team.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The mobile number is where a sign in code is texted when somebody signs in without a password. A
        code always goes to the number recorded here, never to one typed at the sign in screen.
      </p>

      {technicians.length === 0 ? (
        <div className="mt-6">
          <Empty title="No technicians yet">
            Add somebody as a technician and their phones appear here once they sign in.
          </Empty>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {technicians.map((tech) => (
            <section key={tech.id} aria-labelledby={`tech-${tech.id}`}>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 id={`tech-${tech.id}`} className="text-base font-semibold">
                  {tech.name}{!tech.active && <span className="ml-2 align-middle"><Chip tone="neutral">Not active</Chip></span>}
                </h2>
                {writes
                  ? <Mobile id={tech.id} name={tech.name} current={tech.mobilePhone} />
                  : <p className="text-sm text-ink-700">Code texts go to {tech.mobilePhone ?? "no number yet"}</p>}
              </div>

              {tech.devices.length === 0 ? (
                <p className="mt-2 text-sm text-ink-500">Has not signed in on a phone.</p>
              ) : (
                <div className="mt-3">
                  <Table head={<><Th>Phone</Th><Th>Last heard from</Th><Th>Signed in</Th><Th>Day changes</Th><Th><span className="sr-only">Take away</span></Th></>}>
                    {tech.devices.map((device) => {
                      const browser = device.platform === null;
                      const label = device.label ?? (browser ? "Browser" : "Phone");
                      return (
                        <tr key={device.id}>
                          <Td>
                            <span className="block font-medium">{label}</span>
                            <span className="block text-xs text-ink-500">
                              {browser ? "The My day page in a browser" : `${device.platform === "ios" ? "iPhone" : "Android"} app${device.appVersion ? `, version ${device.appVersion}` : ""}`}
                            </span>
                          </Td>
                          <Td>{when(device.lastSeenAt)}</Td>
                          <Td>
                            {device.revokedAt
                              ? <Chip tone="danger">Taken away {when(device.revokedAt)}</Chip>
                              : browser
                                ? <Chip tone="neutral">With their own sign in</Chip>
                                : device.signedIn ? <Chip tone="success">Signed in</Chip> : <Chip tone="neutral">Signed out</Chip>}
                          </Td>
                          <Td>
                            {device.notifications
                              ? <Chip tone="success">Told</Chip>
                              : <Chip tone="neutral">{browser ? "Not by a browser" : "Not told"}</Chip>}
                          </Td>
                          <Td>
                            {writes && !device.revokedAt && !browser ? <Revoke id={device.id} label={label} /> : null}
                          </Td>
                        </tr>
                      );
                    })}
                  </Table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
