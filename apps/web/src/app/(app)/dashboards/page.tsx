import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * THE DASHBOARD LIST, WHICH IS SOMETIMES NOT A LIST
 *
 * With exactly one dashboard visible and no way to make another, this
 * redirects straight into it: a list of one is a click somebody makes every
 * morning for no reason. Anyone who can build reports sees the list, because
 * for them the page is also where a new dashboard starts.
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

  const builds = can(user.actor, "report:build");
  const shipped = dashboards.catalogue(ctx);
  const saved = await dashboards.list(ctx);

  if (shipped.length === 0 && saved.length === 0) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Dashboards" />
        <Empty title="Nothing here you can see">
          Every dashboard that ships needs a permission you do not hold.
        </Empty>
      </div>
    );
  }
  if (!builds && saved.length === 0 && shipped.length === 1) {
    redirect(`/dashboards/${shipped[0]!.slug}`);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Dashboards"
        action={builds ? (
          <a href="/dashboards/new"
             className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
            New dashboard
          </a>
        ) : null}
      />

      {/*
        Yours first. The two that ship are the ones you learn from and the
        ones you assembled are the ones you open every morning, and a list
        that puts the product's own screens above the reader's own is a list
        that says whose product this is.
      */}
      {saved.length > 0 && (
        <>
          <h2 className="mt-6 text-sm font-medium text-ink-700">Yours</h2>
          <ul className="mt-2 space-y-2">
            {saved.map((item) => (
              <li key={item.id}>
                <a href={`/dashboards/saved/${item.id}`}
                   className="block rounded-lg border border-steel-200 bg-canvas px-4 py-3 hover:bg-steel-100">
                  <span className="font-medium">{item.name}</span>
                  <span className="block text-sm text-ink-500">
                    {item.description ?? `${(item.tiles ?? []).length} tiles`}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {shipped.length > 0 && (
        <>
          <h2 className="mt-6 text-sm font-medium text-ink-700">
            {saved.length > 0 ? "That ship with the product" : "To start from"}
          </h2>
          <ul className="mt-2 space-y-2">
            {shipped.map((item) => (
              <li key={item.slug}>
                <a href={`/dashboards/${item.slug}`}
                   className="block rounded-lg border border-steel-200 bg-canvas px-4 py-3 hover:bg-steel-100">
                  <span className="font-medium">{item.title}</span>
                  <span className="block text-sm text-ink-500">{item.description}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {saved.length === 0 && builds && (
        <p className="mt-6 max-w-prose text-sm text-ink-500">
          You can build your own from reports you already have. A tile points
          at a report rather than copying it, so correcting the report
          corrects every dashboard showing it.
        </p>
      )}
    </div>
  );
}
