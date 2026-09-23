import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * THE DASHBOARD LIST, WHICH USUALLY IS NOT A LIST
 *
 * With one dashboard visible this redirects straight into it, because a list
 * of one is a click somebody makes every morning for no reason. It becomes a
 * real list the moment a second one is visible, which for an owner it already
 * is.
 */
export default async function DashboardsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "report:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Dashboards" />
        <Empty title="Dashboards are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const available = dashboards.catalogue(ctx);
  if (available.length === 0) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Dashboards" />
        <Empty title="Nothing here you can see">
          Every dashboard that ships needs a permission you do not hold.
        </Empty>
      </div>
    );
  }
  if (available.length === 1) redirect(`/dashboards/${available[0]!.slug}`);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Dashboards" />
      <ul className="mt-4 space-y-2">
        {available.map((item) => (
          <li key={item.slug}>
            <a href={`/dashboards/${item.slug}`}
               className="block rounded-lg border border-steel-200 bg-canvas px-4 py-3 hover:bg-steel-100">
              <span className="font-medium">{item.title}</span>
              <span className="block text-sm text-ink-500">{item.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
