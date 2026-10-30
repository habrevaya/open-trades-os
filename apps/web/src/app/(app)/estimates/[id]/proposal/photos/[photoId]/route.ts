import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { proposalTemplates } from "@opentradesos/api/services";
import { photoResponse } from "../../../../../../(portal)/photo-response";

/**
 * One photograph an estimate's proposal shows, for the office: the cover, one
 * on its options or the picture of an item on its lines, under the estimate's
 * own read and scope.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; photoId: string }> }) {
  const user = await requireSetupUser();
  const { id, photoId } = await params;
  if (!proposalTemplates.isProposalPhotoId(photoId)) return photoResponse(null);
  return photoResponse(await proposalTemplates.proposalPhoto({ actor: user.actor, db: getDb() }, { estimateId: id, photoId })
    .catch(() => null));
}
