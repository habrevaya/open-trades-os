import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { acquisition, adPlatforms } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { mapCampaign, pullNow } from "./actions";

export const dynamic = "force-dynamic";

/**
 * AD PLATFORMS: WHAT WAS PULLED, WHAT WAS SENT, AND WHAT IT NEEDS
 *
 * One card per connected platform with the last pull of each kind and how it
 * ended, in the platform's own words when it failed, and what a person has
 * to do that nothing else says (sign in again, choose a conversion action).
 * Then the platforms' campaigns and which tracking campaign each is, because
 * pulled spend lands on the platform's channel until somebody says otherwise,
 * and a campaign nobody mapped is spend the tracking campaign's return never
 * sees.
 *
 * Connecting, signing in and disconnecting are on Settings, Integrations,
 * which is `integration:write`; this screen is `adspend:read` to see and
 * `adspend:write` to pull and map.
 */
const ENTITY: Record<string, string> = {
  spend: "Spend", leads: "Local Services leads", reviews: "Reviews", conversions: "Conversions sent",
};
const STATUS: Record<string, string> = {
  connected: "Connected", pending: "Waiting for a sign in", needs_reauth: "Sign in again", error: "Erroring",
};

export default async function PlatformsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const [platforms, campaigns, ours] = await Promise.all([
    adPlatforms.platforms(ctx),
    adPlatforms.listPlatformCampaigns(ctx),
    acquisition.listCampaigns(ctx),
  ]);
  const writes = can(user.actor, "adspend:write");
  const when = (iso: string) => formatIn(new Date(iso), user.organizationTimezone);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Ad platforms" />
      <p className="mt-2 max-w-3xl text-sm text-ink-700">
        Spend pulled from each ad account every six hours, Local Services leads every ten minutes,
        and booked and paid jobs sent back to the account whose click won them every quarter hour.
        Each platform is connected and signed in to on{" "}
        <Link href="/settings/integrations" className="underline underline-offset-4">Settings, Integrations</Link>.
        {" "}What each platform was told, and what was held back and why, is on{" "}
        <Link href="/marketing/platforms/sends" className="underline underline-offset-4">Conversions sent</Link>.
      </p>

      {platforms.length === 0 ? (
        <Empty title="No ad platform is connected">
          Spend still arrives from the file on Marketing, Spend, and conversions still go back as the
          file on Marketing, Conversions. Connecting Google Ads or Meta does both by itself, once the
          platform has approved your developer access.
        </Empty>
      ) : (
        <ul className="mt-6 space-y-4">
          {platforms.map((p) => (
            <li key={p.provider} className="rounded-md border border-steel-200 p-4" aria-label={p.label}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{p.label}</span>
                  <Chip tone={p.status === "connected" ? "success" : p.status === "needs_reauth" ? "danger" : "neutral"}>
                    {STATUS[p.status] ?? p.status}
                  </Chip>
                  {p.signedIn && (
                    <span className="text-xs text-ink-500">
                      Signed in {when(p.signedIn.grantedAt)}
                      {p.signedIn.expiresAt ? `, runs out ${when(p.signedIn.expiresAt)}` : ""}
                    </span>
                  )}
                  {p.ownCredential && <span className="text-xs text-ink-500">Using a token from your own secret store</span>}
                </div>
                {writes && p.status === "connected" && p.provider !== "google_business_profile" && (
                  <ActionForm action={pullNow} submit="Pull now" tone="quiet" hidden={{ provider: p.provider }} className="" />
                )}
              </div>
              {p.notices.map((n) => <p key={n} className="mt-2 rounded bg-amber-tint px-3 py-2 text-sm text-ink-900">{n}</p>)}
              {p.lastError && <p className="mt-2 text-sm text-red-600">{p.lastError}</p>}
              {p.runs.length > 0 ? (
                <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  {p.runs.map((r) => (
                    <div key={r.entity}>
                      <dt className="text-ink-500">{ENTITY[r.entity] ?? r.entity}</dt>
                      <dd className={r.error ? "text-red-600" : "text-ink-900"}>
                        {when(r.startedAt)}: {r.error ? r.error : `${r.read} read, ${r.written} written`}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-3 text-sm text-ink-500">Nothing pulled yet. The first pull runs within a few minutes of signing in.</p>
              )}
              {Object.keys(p.sends).length > 0 && (
                <p className="mt-2 text-sm text-ink-700">
                  Conversions: {Object.entries(p.sends).map(([state, n]) => `${n} ${state}`).join(", ")}.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {campaigns.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">The platforms&rsquo; campaigns, and yours</h2>
          <p className="mt-1 max-w-3xl text-sm text-ink-700">
            A campaign whose name or link tag is one of your tracking campaigns is matched by itself.
            The rest land on the platform&rsquo;s own channel until you say which campaign they are.
            Changing one moves every day of its spend already pulled.
          </p>
          <Table
            label="Platform campaigns"
            head={<><Th>Platform</Th><Th>Their campaign</Th><Th>Last spend</Th><Th>Your tracking campaign</Th></>}
          >
            {campaigns.map((c) => (
              <tr key={c.id}>
                <Td>{c.providerLabel}{c.source === "google_lsa" && c.provider === "google_ads" ? " (Local Services)" : ""}</Td>
                <Td><span className="font-medium">{c.name}</span><span className="block text-xs text-ink-500">{c.externalId}</span></Td>
                <Td className="tabular-nums">{c.lastSpentOn ?? ""}</Td>
                <Td>
                  {writes ? (
                    <ActionForm action={mapCampaign} submit="Save" tone="quiet" hidden={{ id: c.id }} className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor={`map-${c.id}`}>Tracking campaign for {c.name}</label>
                      <select id={`map-${c.id}`} name="campaignId" defaultValue={c.campaignId ?? ""}
                              className="h-9 rounded border border-steel-300 px-2 text-sm">
                        <option value="">None: the platform&rsquo;s own channel</option>
                        {ours.map((o) => <option key={o.id} value={o.id}>{o.channelName}: {o.name}</option>)}
                      </select>
                    </ActionForm>
                  ) : (c.campaignName ?? "Not mapped")}
                  {c.mappedBy === "matched" && <span className="block text-xs text-ink-500">Matched by name</span>}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      )}
    </div>
  );
}
