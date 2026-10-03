import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { websiteTracking } from "@opentradesos/api/services";
import { can, assertCan } from "@opentradesos/core";
import { Chip, Phone } from "@opentradesos/ui";
import { PageHeader, Empty } from "@/components/Table";
import { ActionForm, TextField } from "@/components/ActionForm";
import { setIdleMinutes } from "../actions";

export const dynamic = "force-dynamic";

/**
 * THE WEBSITE SNIPPET, THE NUMBER POOL, AND A PAGE TO TRY THEM ON
 *
 * One line for the company to paste into its site, the pool of numbers the
 * snippet swaps in, who is holding each one right now, and how long a quiet
 * visitor keeps theirs. The test page loads the same snippet on a page with
 * the company's own numbers on it, so the swap can be seen working before
 * anybody touches the real website.
 */
export default async function WebsitePage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "settings:read");
  const ctx = { actor: user.actor, db: getDb() };
  const view = await websiteTracking.overview(ctx);
  const base = (process.env["PUBLIC_URL"] ?? "").replace(/\/$/, "");
  const tag = `<script src="${base}/t.js?c=${view.companyKey}" async></script>`;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Website" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Paste this into every page of your website, just before the closing body tag. It remembers
        how each visitor arrived (the ad, the tag, the referral link), adds that to links to your
        booking page and forms, and shows each visitor their own number from the pool below so a
        call can be traced back to the visit.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-steel-200 bg-steel-100 p-3 text-xs">
        <code aria-label="The snippet to paste">{tag}</code>
      </pre>
      <p className="mt-2 text-sm">
        <a href="/settings/website/test" className="underline underline-offset-4">Try it on a test page</a>
      </p>

      <section className="mt-8">
        <h2 className="text-base font-semibold">The number pool</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          One number per visitor at a time. When every number is held, visitors see the tracking
          number for where they came from, or your main number. Buy pool numbers under
          {" "}<a href="/settings" className="underline underline-offset-4">Settings</a>, choosing Website pool.
        </p>
        {view.pool.length === 0 ? (
          <Empty title="No pool numbers">Without them the snippet still records visits and decorates links, and leaves your numbers as they are.</Empty>
        ) : (
          <ul className="mt-3 divide-y divide-steel-200 rounded-md border border-steel-200">
            {view.pool.map((n) => (
              <li key={n.id} className="flex flex-wrap items-baseline gap-2 p-3">
                <span className="font-medium"><Phone value={n.e164} /></span>
                {n.label ? <span className="text-sm text-ink-500">{n.label}</span> : null}
                <Chip tone={n.heldSince ? "info" : "neutral"}>{n.heldSince ? "Held by a visitor" : "Free"}</Chip>
              </li>
            ))}
          </ul>
        )}
      </section>

      {can(user.actor, "settings:write") && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">How long a quiet visitor keeps a number</h2>
          <ActionForm action={setIdleMinutes} submit="Save" className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="Minutes" name="idleMinutes" type="number" min={5} max={240}
                       defaultValue={String(view.idleMinutes)} className="w-32" />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
