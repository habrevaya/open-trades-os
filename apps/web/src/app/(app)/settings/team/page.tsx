import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { PageHeader } from "@/components/Table";
import { TeamSection } from "./TeamSection";

export const dynamic = "force-dynamic";

/**
 * SETTINGS, TEAM
 *
 * Who works here, what each of them may do, which branch they are in, and
 * the way the next person gets in. Turning somebody off ends their sessions
 * in the same moment and keeps everything they did.
 */
export default async function TeamPage() {
  const user = await requireSetupUser();
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Team" />
      <div className="mt-6">
        <TeamSection ctx={{ actor: user.actor, db: getDb() }} />
      </div>
    </div>
  );
}
