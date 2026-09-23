import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branding } from "@opentradesos/api/services";
import { AppShell } from "@/components/AppShell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSetupUser();
  /**
   * Read here rather than inside the shell, so every page under this layout
   * gets the company's colours in one query instead of one per screen.
   *
   * It needs no permission, deliberately: a technician who cannot open the
   * settings screen is still looking at their own company's application all
   * day, and they are the one person who would have seen it unbranded.
   */
  const brand = await branding.current({ actor: user.actor, db: getDb() });

  return (
    <>
      {/*
        THE FAVICON, INJECTED HERE RATHER THAN DECLARED IN METADATA.
        `metadata.icons` is resolved in the ROOT layout, which does not know
        which company is signed in: it runs above the session. Putting a link
        element in the tree is the only way a per tenant icon reaches the
        head, and React hoists it there.

        `?v=` on the href is what makes a replacement take effect. A favicon
        is the single most aggressively cached thing a browser holds, and
        without a changing URL somebody replaces theirs and sees the old one
        for a week.
      */}
      {brand?.hasFavicon && (
        <link rel="icon" href={`/brand/favicon?v=${brand.version}`} />
      )}
      <AppShell user={user} brand={brand}>{children}</AppShell>
    </>
  );
}
