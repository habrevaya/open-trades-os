import { portalAccess } from "@opentradesos/api/services";
import { can, type Actor } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import type { getDb } from "@/lib/db";
import { Attempts } from "../../settings/portal/sign-ins/Attempts";
import { endPortalSessions } from "./portal-actions";

const ENDED: Record<string, string> = {
  signed_out: "they signed out",
  office: "signed out by the office",
  access_removed: "their access was taken away",
};

/**
 * THEIR SIGN INS, ON THEIR PAGE
 *
 * Who is signed in to this customer's account (the customer, or a contact
 * the office let sign in as them), from where and until when, with a button
 * to end it, and the codes asked for at their addresses that did not work.
 * Drawn only for somebody with `portal:read`, and the button only for
 * somebody with `portal:revoke`.
 */
export async function PortalSignIns({ ctx, customerId, timezone }: {
  ctx: { actor: Actor; db: ReturnType<typeof getDb> };
  customerId: string;
  timezone: string;
}) {
  if (!can(ctx.actor, "portal:read")) return null;
  const [{ sessions }, { attempts }] = await Promise.all([
    portalAccess.sessions(ctx, { customerId }),
    portalAccess.attempts(ctx, { customerId, limit: 20 }),
  ]);
  const ending = can(ctx.actor, "portal:revoke");
  const open = sessions.filter((s) => s.active);
  const recent = sessions.filter((s) => !s.active).slice(0, 5);

  return (
    <section aria-label="Portal sign ins" className="mt-10">
      <h2 className="text-base font-semibold">Portal sign ins</h2>
      {open.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">Nobody is signed in to their account.</p>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {open.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
              <span>
                <span className="font-medium">{s.contactName ?? "The customer"}</span>
                {s.address && <span className="text-ink-700">, with {s.address}</span>}
                <span className="block text-xs text-ink-500">
                  Since {formatIn(s.startedAt, timezone)}, until {formatIn(s.expiresAt, timezone)}
                  {s.lastUsedIp ? `, last from ${s.lastUsedIp}` : ""}
                </span>
              </span>
              {ending && (
                <ActionForm action={endPortalSessions} submit="Sign them out" tone="quiet"
                            hidden={{ customerId, sessionId: s.id }} className="ml-auto" />
              )}
            </li>
          ))}
        </ul>
      )}
      {ending && open.length > 1 && (
        <ActionForm action={endPortalSessions} submit="Sign out everywhere" tone="quiet"
                    hidden={{ customerId }} className="mt-2" />
      )}
      {recent.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-ink-500">
          {recent.map((s) => (
            <li key={s.id}>
              {s.contactName ?? "The customer"} signed in {formatIn(s.startedAt, timezone)}
              {s.endedAt ? `, ended ${formatIn(s.endedAt, timezone)} (${ENDED[s.endedReason ?? ""] ?? "ended"})` : ", ran out"}
            </li>
          ))}
        </ul>
      )}
      {attempts.length > 0 && (
        <Attempts attempts={attempts} timezone={timezone} showCustomer={false} label="Their sign in codes" />
      )}
    </section>
  );
}
