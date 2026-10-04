import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { proposalTemplates } from "@opentradesos/api/services";
import { photoResponse } from "../../../../../(portal)/photo-response";

/** A layout's cover photograph, for its editor. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  return photoResponse(await proposalTemplates.templatePhoto({ actor: user.actor, db: getDb() }, { id }).catch(() => null));
}
