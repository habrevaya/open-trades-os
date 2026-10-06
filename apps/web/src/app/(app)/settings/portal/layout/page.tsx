import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { portalLayout } from "@opentradesos/api/services";
import { can, assertCan } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { LayoutEditor } from "./LayoutEditor";
import { saveLayout } from "./actions";

export const dynamic = "force-dynamic";

/**
 * WHAT A CUSTOMER'S ACCOUNT PAGE SHOWS, AND IN WHAT ORDER
 *
 * Starts from the layout your trade pack set up, as the customer sees it now,
 * then every block you could add. Moving, hiding and renaming is saved as your
 * own layout, which a trade pack upgrade never writes over.
 */
export default async function PortalLayoutPage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "settings:read");
  const layout = await portalLayout.get({ actor: user.actor, db: getDb() });
  const writes = can(user.actor, "settings:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/settings/portal">Customer portal</Crumb>
      <h1 className="mt-1 text-xl font-semibold">What customers see on their account</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        {layout.startedFrom
          ? `This started from the ${layout.startedFrom} layout your trade pack set up. `
          : "No trade pack has set this up, so it starts from what every account shows. "}
        Put the blocks in the order you want, untick the ones customers should not see, and change any heading.
        The bills are always shown, because customers need to see what they owe.
        {layout.changed ? " A trade pack upgrade keeps your changes." : ""}
      </p>
      {writes ? (
        <LayoutEditor rows={layout.blocks} save={saveLayout} />
      ) : (
        <ol className="mt-4 space-y-1 text-sm">
          {layout.blocks.map((b) => (
            <li key={b.kind}>{b.title}{b.visible ? "" : " (hidden)"}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
