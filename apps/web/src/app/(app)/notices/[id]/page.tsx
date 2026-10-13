import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { staffNotices } from "@opentradesos/api/services";
import { Empty } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * OPENING A NOTICE
 *
 * Marks it read and goes to the record it is about, at the page worked out for
 * this person now: a licence is their own `/me` for the holder and the
 * holder's page for a manager. Asked again here rather than trusted from when
 * it was raised, so somebody whose access was narrowed since is told they
 * cannot open it rather than sent to a page that refuses them.
 */
export default async function OpenNoticePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  let href: string | null = null;
  try {
    href = (await staffNotices.open({ actor: user.actor, db: getDb() }, { id })).href;
  } catch (error) {
    if (!(error instanceof Error) || !["NotFoundError", "PermissionError", "ConflictError"].includes(error.name)) throw error;
  }
  if (href) redirect(href);
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-xl font-semibold">Notice</h1>
      <Empty title="This cannot be opened">
        It is not yours, or what it was about has gone, or you can no longer open it. <a href="/notices" className="text-blue-600 underline underline-offset-4">Back to your notices</a>
      </Empty>
    </div>
  );
}
